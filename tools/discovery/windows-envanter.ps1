<#
.SYNOPSIS
  SAKLAZ AI — Windows ortam envanteri (SALT OKUNUR).

.DESCRIPTION
  SAKLAZ ajanının çalışacağı Windows bilgisayarın uyumluluğunu belirlemek için
  bilgi toplar. Hiçbir ayarı, dosyayı veya kayıt defteri anahtarını DEĞİŞTİRMEZ.
  Hiçbir veriyi ağ üzerinden GÖNDERMEZ (yalnızca isteğe bağlı bir HTTPS erişim
  testi yapar). Çıktı yerel bir JSON dosyasına yazılır; kullanıcı inceleyip
  paylaşıp paylaşmamaya kendisi karar verir.

  Toplanmayanlar: dosya içerikleri, e-postalar, parolalar, tarayıcı verisi,
  kişisel belgeler.

.PARAMETER RelayTestUrl
  İsteğe bağlı. Giden HTTPS (443) erişimini test etmek için bir adres.
  Verilmezse ağ testi yapılmaz.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\windows-envanter.ps1
  powershell -ExecutionPolicy Bypass -File .\windows-envanter.ps1 -RelayTestUrl https://relay.ornek.com.tr
#>
[CmdletBinding()]
param(
  [string]$RelayTestUrl
)

$ErrorActionPreference = 'Continue'
$sonuc = [ordered]@{ olusturma = (Get-Date).ToString('s'); surum = '0.1' }

function Dene($ad, [scriptblock]$blok) {
  try { $sonuc[$ad] = & $blok } catch { $sonuc[$ad] = "HATA: $($_.Exception.Message)" }
}

# 1. İşletim sistemi
Dene 'isletim_sistemi' {
  $os = Get-CimInstance Win32_OperatingSystem
  [ordered]@{
    ad = $os.Caption; surum = $os.Version; derleme = $os.BuildNumber
    mimari = $os.OSArchitecture; dil = (Get-Culture).Name
    displayVersion = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue).DisplayVersion
  }
}

# 2. Donanım (özet)
Dene 'donanim' {
  $cs = Get-CimInstance Win32_ComputerSystem
  [ordered]@{
    ram_gb = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
    islemci = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name
    alan_adina_bagli = $cs.PartOfDomain
  }
}

# 3. Kullanıcı yetkisi (yönetici mi?)
Dene 'kullanici' {
  $kimlik = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($kimlik)
  [ordered]@{
    yonetici_mi = $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    alan_kullanicisi_mi = ($kimlik.Name -notlike "$env:COMPUTERNAME\*")
  }
}

# 4. Microsoft Office (kurulu sürüm ve kanal)
Dene 'office' {
  $c2r = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration' -ErrorAction SilentlyContinue
  $outlookYolu = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\OUTLOOK.EXE' -ErrorAction SilentlyContinue).'(default)'
  $yeniOutlook = Get-AppxPackage -Name 'Microsoft.OutlookForWindows' -ErrorAction SilentlyContinue
  [ordered]@{
    click_to_run_surum = $c2r.VersionToReport
    urunler = $c2r.ProductReleaseIds
    kanal = $c2r.CDNBaseUrl
    klasik_outlook_kurulu = [bool]$outlookYolu
    yeni_outlook_kurulu = [bool]$yeniOutlook
  }
}

# 5. Güvenlik yazılımları (yalnız durum)
Dene 'guvenlik' {
  $mp = Get-MpComputerStatus -ErrorAction SilentlyContinue
  $av = Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction SilentlyContinue
  $bl = Get-BitLockerVolume -MountPoint $env:SystemDrive -ErrorAction SilentlyContinue
  [ordered]@{
    defender_aktif = $mp.AntivirusEnabled
    gercek_zamanli_koruma = $mp.RealTimeProtectionEnabled
    antivirus_urunleri = @($av | ForEach-Object { $_.displayName })
    bitlocker_sistem_surucusu = if ($bl) { "$($bl.ProtectionStatus)" } else { 'bilinmiyor (yonetici yetkisi gerekebilir)' }
    smartscreen = (Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' -ErrorAction SilentlyContinue).EnableSmartScreen
    applocker_politikasi_var = [bool](Get-AppLockerPolicy -Effective -ErrorAction SilentlyContinue).RuleCollections.Count
  }
}

# 6. Ağ ve proxy
Dene 'ag' {
  $winhttp = (netsh winhttp show proxy) -join ' '
  $ie = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
  [ordered]@{
    winhttp_proxy = $winhttp.Trim()
    kullanici_proxy_aktif = [bool]$ie.ProxyEnable
    kullanici_proxy = $ie.ProxyServer
    pac_adresi = $ie.AutoConfigURL
  }
}

# 7. Geliştirme ve çalışma zamanı bileşenleri
Dene 'calisma_zamani' {
  $node = Get-Command node -ErrorAction SilentlyContinue
  [ordered]@{
    powershell = $PSVersionTable.PSVersion.ToString()
    dotnet_framework = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -ErrorAction SilentlyContinue).Release
    node = if ($node) { $node.Version.ToString() } else { $null }
    vc_redist_x64 = [bool](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64' -ErrorAction SilentlyContinue)
    windows_hello_destegi = [bool](Get-CimInstance -Namespace root/cimv2/mdm/dmmap -ClassName MDM_PassportForWork_Policies01 -ErrorAction SilentlyContinue) -or (Test-Path 'C:\Windows\System32\WinBioPlugIns')
  }
}

# 8. Disk alanı
Dene 'disk' {
  Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
    [ordered]@{ surucu = $_.DeviceID; bos_gb = [math]::Round($_.FreeSpace / 1GB, 1); toplam_gb = [math]::Round($_.Size / 1GB, 1) }
  }
}

# 9. Dinlenen portlar (SAKLAZ ajanı port AÇMAYACAK; mevcut durumu kayıt altına almak için)
Dene 'dinlenen_port_sayisi' {
  (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count
}

# 10. İsteğe bağlı giden HTTPS testi
if ($RelayTestUrl) {
  Dene 'giden_https_testi' {
    $u = [uri]$RelayTestUrl
    $t = Test-NetConnection -ComputerName $u.Host -Port 443 -WarningAction SilentlyContinue
    [ordered]@{ hedef = $u.Host; tcp_443_basarili = $t.TcpTestSucceeded }
  }
}

$dosya = Join-Path (Get-Location) ("saklaz-envanter-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$sonuc | ConvertTo-Json -Depth 6 | Out-File -FilePath $dosya -Encoding utf8
Write-Host "Envanter yazildi: $dosya"
Write-Host "Dosyayi inceleyin; paylasmadan once istemediginiz alanlari silebilirsiniz."
