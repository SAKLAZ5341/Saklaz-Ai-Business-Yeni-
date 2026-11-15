# Pester 5 — tools/ci/lib/AdsiUser.psm1: "kullanıcı yok" ile "sorgu yapılamadı" ayrımı.
BeforeAll {
  Import-Module (Join-Path $PSScriptRoot 'lib/AdsiUser.psm1') -Force
  function New-Com([int]$hr) { [System.Runtime.InteropServices.COMException]::new('benzetilmiş', $hr) }
  # PowerShell'in .NET/COM çağrı hatalarını sardığı biçim
  function New-Wrapped([System.Exception]$inner) { [System.Management.Automation.MethodInvocationException]::new('Exception calling "Exists"', $inner) }
  $script:NotFound = -2147022675     # 0x800708AD NERR_UserNotFound
  $script:AccessDenied = -2147024891 # 0x80070005
  $script:RpcUnavailable = -2147023174 # 0x800706BA
}

Describe 'Resolve-AdsiUserQuery' {
  It 'sorgu $true döndürürse kullanıcı vardır' { Resolve-AdsiUserQuery { $true } | Should -BeTrue }
  It 'sorgu $false döndürürse kullanıcı yoktur' { Resolve-AdsiUserQuery { $false } | Should -BeFalse }
  It 'NERR_UserNotFound (sarılı) → kullanıcı yok' {
    Resolve-AdsiUserQuery { throw (New-Wrapped (New-Com $script:NotFound)) } | Should -BeFalse
  }
  It 'NERR_UserNotFound (çıplak COM) → kullanıcı yok' {
    Resolve-AdsiUserQuery { throw (New-Com $script:NotFound) } | Should -BeFalse
  }
  It 'erişim reddi → istisna (kullanıcı yok SAYILMAZ)' {
    { Resolve-AdsiUserQuery { throw (New-Wrapped (New-Com $script:AccessDenied)) } } | Should -Throw '*0x80070005*'
  }
  It 'RPC sunucusu yok → istisna' {
    { Resolve-AdsiUserQuery { throw (New-Wrapped (New-Com $script:RpcUnavailable)) } } | Should -Throw '*0x800706BA*'
  }
  It 'COM dışı hata → istisna' {
    { Resolve-AdsiUserQuery { throw [System.IO.IOException]::new('disk') } } | Should -Throw '*kullanıcı sorgusu*'
  }
}

Describe 'Resolve-AdsiUserDelete' {
  It 'başarılı silme → deleted' { Resolve-AdsiUserDelete { } | Should -Be 'deleted' }
  It 'zaten yok → absent' { Resolve-AdsiUserDelete { throw (New-Wrapped (New-Com $script:NotFound)) } | Should -Be 'absent' }
  It 'erişim reddi → istisna' {
    { Resolve-AdsiUserDelete { throw (New-Wrapped (New-Com $script:AccessDenied)) } } | Should -Throw '*kullanıcı silme*0x80070005*'
  }
}
