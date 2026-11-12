<#
  Pester 5 testleri — windows-envanter.ps1 (FAZ1-PLAN §10.6, karar D6).

  Amaç: betiğin
    1) sözdizimsel olarak geçerli olduğunu,
    2) YALNIZCA salt okunur komutlar çağırdığını (statik AST denetimi),
    3) hatasız tamamlanıp geçerli JSON ürettiğini,
    4) -RelayTestUrl verilmedikçe hiçbir ağ bağlantısı denemediğini,
    5) Windows'ta kayıt defterinde ve dosya sisteminde HİÇBİR değişiklik yapmadığını
  kanıtlamak.

  Çalıştırma:  Invoke-Pester -Path tools/discovery/windows-envanter.Tests.ps1 -Output Detailed
  Not: 5. madde yalnızca Windows'ta çalışır; Linux/macOS'ta atlanır (Skipped olarak raporlanır).
#>

BeforeAll {
  $script:ScriptPath = Join-Path $PSScriptRoot 'windows-envanter.ps1'

  function Invoke-Envanter {
    param([hashtable]$Arguments = @{})
    $out = Join-Path $TestDrive ([guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $out | Out-Null
    Push-Location $out
    try {
      & $script:ScriptPath @Arguments *> $null
      Get-ChildItem -Path $out -Filter 'saklaz-envanter-*.json'
    } finally {
      Pop-Location
    }
  }
}

Describe 'windows-envanter.ps1 — statik denetimler' {
  BeforeAll {
    $tokens = $null; $errors = $null
    $script:Ast = [System.Management.Automation.Language.Parser]::ParseFile($script:ScriptPath, [ref]$tokens, [ref]$errors)
    $script:ParseErrors = $errors
    $script:Commands = $script:Ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true) |
      ForEach-Object { $_.GetCommandName() } | Where-Object { $_ } | Sort-Object -Unique
  }

  It 'sözdizimi hatası içermez' {
    $script:ParseErrors | Should -BeNullOrEmpty
  }

  It 'yalnızca izin verilen (salt okunur) komutları çağırır' {
    # Bu liste bilinçli olarak dar tutulur. Yeni bir komut eklemek, bu testi güncellemeyi ve
    # komutun salt okunur olduğunu gerekçelendirmeyi gerektirir.
    $allowed = @(
      'Get-CimInstance', 'Get-ItemProperty', 'Get-Culture', 'Get-MpComputerStatus', 'Get-BitLockerVolume',
      'Get-AppLockerPolicy', 'Get-AppxPackage', 'Get-Command', 'Get-NetTCPConnection', 'Get-Date',
      'Get-Location', 'Measure-Object', 'ForEach-Object', 'Test-NetConnection', 'ConvertTo-Json',
      'Out-File', 'Join-Path', 'Write-Host', 'Dene', 'netsh', 'Test-Path',
      # New-Object: yalnızca bellek içi WindowsPrincipal nesnesi; Select-Object: -First 1 seçimi
      'New-Object', 'Select-Object'
    )
    $unexpected = $script:Commands | Where-Object { $_ -notin $allowed }
    $unexpected | Should -BeNullOrEmpty -Because "beklenmeyen komutlar: $($unexpected -join ', ')"
  }

  It 'yazma, silme, süreç başlatma veya veri gönderme komutu içermez' {
    $forbidden = @(
      'Set-ItemProperty', 'New-ItemProperty', 'Remove-ItemProperty', 'New-Item', 'Remove-Item', 'Set-Item',
      'Set-Content', 'Add-Content', 'Clear-Content', 'Copy-Item', 'Move-Item', 'Rename-Item',
      'Set-MpPreference', 'Add-MpPreference', 'Stop-Service', 'Start-Service', 'Set-Service', 'Restart-Computer',
      'Start-Process', 'Invoke-Expression', 'Invoke-WebRequest', 'Invoke-RestMethod', 'Send-MailMessage',
      'reg', 'sc', 'Enable-BitLocker', 'Disable-BitLocker', 'Set-NetFirewallRule', 'New-NetFirewallRule'
    )
    ($script:Commands | Where-Object { $_ -in $forbidden }) | Should -BeNullOrEmpty
  }

  It 'netsh yalnızca "show" alt komutuyla kullanılır' {
    $netsh = $script:Ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'netsh' }, $true)
    foreach ($c in $netsh) {
      ($c.CommandElements | ForEach-Object { $_.Extent.Text }) -join ' ' | Should -Match '^netsh winhttp show proxy$'
    }
  }

  It 'Test-NetConnection yalnızca -RelayTestUrl verildiğinde çalışan bloğun içindedir' {
    $tnc = $script:Ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Test-NetConnection' }, $true)
    $tnc.Count | Should -Be 1
    $p = $tnc[0].Parent
    $insideGuard = $false
    while ($p) {
      if ($p -is [System.Management.Automation.Language.IfStatementAst] -and $p.Clauses[0].Item1.Extent.Text -match '\$RelayTestUrl') { $insideGuard = $true; break }
      $p = $p.Parent
    }
    $insideGuard | Should -BeTrue
  }
}

Describe 'windows-envanter.ps1 — çalışma zamanı' {
  It 'hatasız tamamlanır ve tek bir geçerli JSON dosyası üretir' {
    $files = Invoke-Envanter
    @($files).Count | Should -Be 1
    $json = Get-Content -Raw -Path $files[0].FullName | ConvertFrom-Json
    $json.surum | Should -Be '0.1'
    $json.olusturma | Should -Not -BeNullOrEmpty
    $json.PSObject.Properties.Name | Should -Contain 'isletim_sistemi'
    $json.PSObject.Properties.Name | Should -Contain 'office'
    $json.PSObject.Properties.Name | Should -Not -Contain 'giden_https_testi'
  }

  It '-RelayTestUrl verilmedikçe ağ bağlantısı denemez; verilirse yalnızca bir kez dener' {
    if (-not (Get-Command Test-NetConnection -ErrorAction SilentlyContinue)) {
      function global:Test-NetConnection { param($ComputerName, $Port, $WarningAction) }
    }
    try {
      Mock Test-NetConnection { [pscustomobject]@{ TcpTestSucceeded = $true } }
      Invoke-Envanter | Out-Null
      Should -Invoke Test-NetConnection -Times 0 -Exactly
      $files = Invoke-Envanter -Arguments @{ RelayTestUrl = 'https://relay.ornek.invalid' }
      Should -Invoke Test-NetConnection -Times 1 -Exactly
      (Get-Content -Raw $files[0].FullName | ConvertFrom-Json).giden_https_testi.hedef | Should -Be 'relay.ornek.invalid'
    } finally {
      Remove-Item function:global:Test-NetConnection -ErrorAction SilentlyContinue
    }
  }
}

Describe 'windows-envanter.ps1 — değişiklik yapmama kanıtı (yalnız Windows)' -Skip:(-not $IsWindows) {
  It 'kayıt defteri ve ortam değişkenleri değişmez' {
    function Get-Snapshot {
      $reg = foreach ($k in @(
          'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings',
          'HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration',
          'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
        )) {
        if (Test-Path $k) { (Get-ItemProperty $k | ConvertTo-Json -Depth 3 -Compress) }
      }
      $subkeys = (Get-ChildItem 'HKCU:\Software' -ErrorAction SilentlyContinue).Name -join '|'
      $env = (Get-ChildItem env: | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join "`n"
      [pscustomobject]@{ Reg = ($reg -join "`n"); Subkeys = $subkeys; Env = $env }
    }
    $before = Get-Snapshot
    Invoke-Envanter | Out-Null
    $after = Get-Snapshot
    $after.Reg | Should -BeExactly $before.Reg
    $after.Subkeys | Should -BeExactly $before.Subkeys
    $after.Env | Should -BeExactly $before.Env
  }
}
