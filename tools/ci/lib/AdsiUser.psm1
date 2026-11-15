# SAKLAZ AI — yerel kullanıcı sorgusu ve silme (ADSI WinNT sağlayıcısı) için hata sınıflandırması.
#
# WinNT sağlayıcısı, kullanıcı yoksa NERR_UserNotFound (HRESULT 0x800708AD) taşıyan bir COM istisnası
# atar. Bu YALNIZCA "kullanıcı yok" anlamına gelir. Diğer her hata (erişim reddi, RPC/ağ, sağlayıcı
# hatası…) sorgunun YAPILAMADIĞI anlamına gelir ve "kullanıcı yok" sayılmamalıdır: aksi hâlde silinemeyen
# bir kullanıcı temizlenmiş gibi raporlanır. Beklenmeyen hata çağırana istisna olarak iletilir.
Set-StrictMode -Version Latest

# 0x800708AD (NERR_UserNotFound) — Int32 olarak.
$script:NERR_UserNotFound = -2147022675

function Get-AdsiHResult {
  [OutputType([int])]
  param([Parameter(Mandatory)][System.Exception]$Exception)
  # PowerShell, COM istisnasını MethodInvocationException vb. içine sarar: zincirdeki COM istisnası aranır.
  for ($x = $Exception; $null -ne $x; $x = $x.InnerException) {
    if ($x -is [System.Runtime.InteropServices.COMException]) { return $x.HResult }
  }
  for ($x = $Exception; $null -ne $x.InnerException; $x = $x.InnerException) { }
  return $x.HResult
}

function Test-AdsiUserNotFound {
  [OutputType([bool])]
  param([Parameter(Mandatory)][System.Exception]$Exception)
  return (Get-AdsiHResult $Exception) -eq $script:NERR_UserNotFound
}

function New-AdsiQueryError([string]$What, [System.Exception]$Inner) {
  $hr = Get-AdsiHResult $Inner
  return [System.InvalidOperationException]::new(("{0}: beklenmeyen ADSI hatası (HRESULT 0x{1:X8})" -f $What, $hr), $Inner)
}

# Sorgu bloğunu çalıştırır: $true/$false döndürür; yalnızca NERR_UserNotFound "yok" ($false) sayılır.
function Resolve-AdsiUserQuery {
  [OutputType([bool])]
  param([Parameter(Mandatory)][scriptblock]$Query)
  try {
    return [bool](& $Query)
  } catch {
    if (Test-AdsiUserNotFound $_.Exception) { return $false }
    throw (New-AdsiQueryError 'kullanıcı sorgusu' $_.Exception)
  }
}

function Test-LocalUserExists {
  [OutputType([bool])]
  param([Parameter(Mandatory)][string]$Computer, [Parameter(Mandatory)][string]$Name)
  return Resolve-AdsiUserQuery { [ADSI]::Exists("WinNT://$Computer/$Name,user") }
}

# Silme bloğunu çalıştırır: 'deleted' ya da (kullanıcı zaten yoksa) 'absent' döndürür; diğer hatalar istisna.
function Resolve-AdsiUserDelete {
  [OutputType([string])]
  param([Parameter(Mandatory)][scriptblock]$Delete)
  try {
    & $Delete | Out-Null
    return 'deleted'
  } catch {
    if (Test-AdsiUserNotFound $_.Exception) { return 'absent' }
    throw (New-AdsiQueryError 'kullanıcı silme' $_.Exception)
  }
}

Export-ModuleMember -Function Get-AdsiHResult, Test-AdsiUserNotFound, Resolve-AdsiUserQuery, Test-LocalUserExists, Resolve-AdsiUserDelete
