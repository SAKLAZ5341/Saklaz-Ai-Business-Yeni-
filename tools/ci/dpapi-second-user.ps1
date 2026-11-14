# SAKLAZ AI — DPAPI kullanıcı izolasyonu testi (Sprint 3 A3, test planı T-A3-22a ve T-A3-22b).
#
# YALNIZCA GitHub Actions'ın geçici Windows sanal makinesinde çalışır (iş yönetici olarak koşar; kullanıcı
# oluşturmak ve görev kaydetmek için gerekir). İkinci kullanıcı (B) STANDART kullanıcıdır.
#   1. İş kullanıcısı (A): ham DPAPI blob'u (probe.mjs) ve gerçek ProtectedKeyStore dosyası (kek.bin) oluşturur.
#   2. Geçici, rastgele parolalı standart yerel kullanıcı B oluşturulur: yalnızca Users grubu; Administrators'a
#      EKLENMEZ. Zamanlanmış görev için yalnızca "toplu iş olarak oturum açma" hakkı verilir.
#   3. B adına (profili yüklenerek, sınırlı yetkiyle; /rl highest YOK) A'nın verileri açılmaya çalışılır:
#        • ham DPAPI blob'u          → beklenen UNPROTECT_FAILED
#        • gerçek kek.bin dosyası    → beklenen BINDING_MISMATCH (SID bağlama denetimi DPAPI'den önce)
#      B kendi blob'unu ve kendi kek.bin dosyasını açabilmelidir (DPAPI B için çalışıyor; başarısızlığın
#      nedeni izolasyondur). Sonunda A da kendi verilerini hâlâ açabilmelidir.
#
# Parola: yalnızca bu sürecin belleğinde. Hiçbir alt sürecin komut satırına, dosyaya veya günlüğe yazılmaz:
# kullanıcı ADSI (süreç içi COM) ile, görev Register-ScheduledTask (süreç içi) ile oluşturulur; net.exe ve
# schtasks.exe KULLANILMAZ. Düz metin anahtar hiçbir yerde yazılmaz (yalnızca SHA-256 özetleri).
# Temizlik "finally" içinde her durumda yapılır: görev, toplu iş hakkı, kullanıcı, kullanıcı profili, dosyalar.
$ErrorActionPreference = 'Stop'
if (-not $env:GITHUB_ACTIONS) { throw 'Bu betik yalnızca CI içindir (yerel kullanıcı oluşturur).' }

$root  = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$kp    = Join-Path $root 'packages\win-keyprotect'
$probe = Join-Path $kp 'scripts\probe.mjs'
$ksprobe = Join-Path $kp 'dist\keystore-probe.mjs'
$node  = (Get-Command node).Source
$work  = Join-Path $env:RUNNER_TEMP ("dpapi-" + [guid]::NewGuid().ToString('N'))
$user  = 'saklazdpapit2'
$task  = 'saklaz-dpapi-izolasyon'
if (-not (Test-Path $ksprobe)) { throw "keystore-probe paketi yok: önce 'pnpm --filter @saklaz/agent run build:probe'" }
New-Item -ItemType Directory -Path $work | Out-Null

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class SaklazLsa {
  [StructLayout(LayoutKind.Sequential)] struct LSA_UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct LSA_OBJECT_ATTRIBUTES { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
  [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr systemName, ref LSA_OBJECT_ATTRIBUTES attrs, uint access, out IntPtr handle);
  [DllImport("advapi32.dll")] static extern uint LsaAddAccountRights(IntPtr handle, byte[] sid, LSA_UNICODE_STRING[] rights, uint count);
  [DllImport("advapi32.dll")] static extern uint LsaRemoveAccountRights(IntPtr handle, byte[] sid, bool all, LSA_UNICODE_STRING[] rights, uint count);
  [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr handle);
  [DllImport("advapi32.dll")] static extern int LsaNtStatusToWinError(uint status);
  static void Change(string sid, string right, bool add) {
    var attrs = new LSA_OBJECT_ATTRIBUTES();
    IntPtr h;
    uint st = LsaOpenPolicy(IntPtr.Zero, ref attrs, 0x00000810, out h); // POLICY_CREATE_ACCOUNT | POLICY_LOOKUP_NAMES
    if (st != 0) throw new Win32Exception(LsaNtStatusToWinError(st));
    try {
      var s = new SecurityIdentifier(sid);
      var b = new byte[s.BinaryLength];
      s.GetBinaryForm(b, 0);
      var u = new LSA_UNICODE_STRING();
      u.Buffer = Marshal.StringToHGlobalUni(right);
      u.Length = (ushort)(right.Length * 2);
      u.MaximumLength = (ushort)(u.Length + 2);
      try { st = add ? LsaAddAccountRights(h, b, new[] { u }, 1) : LsaRemoveAccountRights(h, b, false, new[] { u }, 1); }
      finally { Marshal.FreeHGlobal(u.Buffer); }
      if (st != 0) throw new Win32Exception(LsaNtStatusToWinError(st));
    } finally { LsaClose(h); }
  }
  public static void Grant(string sid, string right) { Change(sid, right, true); }
  public static void Revoke(string sid, string right) { Change(sid, right, false); }
}
'@

function Invoke-Native([string]$what, [scriptblock]$Block) {
  & $Block | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "$what başarısız (çıkış $LASTEXITCODE)" }
}
function Group-Name([string]$sid) {
  ((New-Object System.Security.Principal.SecurityIdentifier $sid).Translate([System.Security.Principal.NTAccount]).Value -split '\\')[-1]
}

$computer = [ADSI]"WinNT://$env:COMPUTERNAME,computer"
$created = $false
$sidB = $null
$batchGranted = $false
try {
  # 1. A: ham blob ve gerçek kasa anahtarı dosyası
  Invoke-Native 'A: ham blob' { & $node $probe protect (Join-Path $work 'blob.bin') }
  Invoke-Native 'A: kek.bin oluşturma' { & $node $ksprobe create (Join-Path $work 'kek-a.bin') }
  $sidA = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value

  # 2. B: standart kullanıcı. Parola rastgele; yalnızca bellekte.
  $chars = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $bytes = New-Object byte[] 20
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $pw = 'Aa1!' + (-join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] }))
  $u = $computer.Create('User', $user)
  $u.SetPassword($pw)
  $u.Put('Description', 'SAKLAZ CI geçici standart kullanıcı (DPAPI izolasyon testi)')
  $u.SetInfo()
  $created = $true
  $usersGroup = Group-Name 'S-1-5-32-545'
  ([ADSI]"WinNT://$env:COMPUTERNAME/$usersGroup,group").Add("WinNT://$env:COMPUTERNAME/$user,user")
  $sidB = (New-Object System.Security.Principal.NTAccount "$env:COMPUTERNAME\$user").Translate([System.Security.Principal.SecurityIdentifier]).Value
  $adminMembers = net localgroup (Group-Name 'S-1-5-32-544')
  if ($LASTEXITCODE -ne 0) { throw 'Administrators üyeleri okunamadı' }
  if ($adminMembers -contains $user -or $adminMembers -contains "$env:COMPUTERNAME\$user") { throw 'B, Administrators grubunda; test geçersiz' }
  [SaklazLsa]::Grant($sidB, 'SeBatchLogonRight')
  $batchGranted = $true

  # 3. B'nin okuması gereken yerler: çalışma klasörü (yazma), paket (okuma/çalıştırma), Node çalışma zamanı
  Invoke-Native 'çalışma klasörü izni' { icacls $work /grant "${user}:(OI)(CI)M" }
  Invoke-Native 'paket okuma izni' { icacls $kp /grant "${user}:(OI)(CI)RX" /T /C /Q }
  Invoke-Native 'Node okuma izni' { icacls (Split-Path $node) /grant "${user}:(OI)(CI)RX" /T /C /Q }

  $resBlob = Join-Path $work 'result-blob.json'
  $resKs = Join-Path $work 'result-ks.json'
  $runCmd = Join-Path $work 'run-b.cmd'
  if ($runCmd -match '\s') { throw "Görev yolu boşluk içeriyor: $runCmd" }
  $log = Join-Path $work 'b.log'
  Set-Content -Path $runCmd -Encoding ascii -Value @(
    '@echo off',
    "`"$node`" `"$probe`" cross `"$(Join-Path $work 'blob.bin')`" `"$resBlob`" > `"$log`" 2>&1",
    "`"$node`" `"$ksprobe`" cross `"$(Join-Path $work 'kek-a.bin')`" `"$resKs`" `"$(Join-Path $work 'kek-b.bin')`" >> `"$log`" 2>&1"
  )

  # 4. Görev: B adına, parola ile (profil yüklenir), sınırlı yetki. Süreç içi kayıt: parola argv'de değil.
  $action = New-ScheduledTaskAction -Execute $runCmd
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries
  Register-ScheduledTask -TaskName $task -Action $action -Settings $settings -User "$env:COMPUTERNAME\$user" -Password $pw -RunLevel Limited -Force | Out-Null
  $pw = $null
  Start-ScheduledTask -TaskName $task
  $deadline = (Get-Date).AddSeconds(180)
  while (-not ((Test-Path $resBlob) -and (Test-Path $resKs)) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
  if (-not ((Test-Path $resBlob) -and (Test-Path $resKs))) {
    $info = Get-ScheduledTaskInfo -TaskName $task
    $blog = if (Test-Path $log) { Get-Content $log -Raw } else { '(günlük yok)' }
    throw "B görevi sonuç üretmedi (LastTaskResult=$($info.LastTaskResult)). Günlük: $blog"
  }
  $rb = Get-Content $resBlob -Raw | ConvertFrom-Json
  $rk = Get-Content $resKs -Raw | ConvertFrom-Json
  Write-Host ("A SID: {0}`nB SID: {1} (standart kullanıcı, Administrators üyesi değil)" -f $sidA, $sidB)
  Write-Host ("Ham DPAPI blob'u — B, A'nınkini çözebildi mi: {0} (kod: {1}); B kendi blob'unda: {2}" -f $rb.crossOk, $rb.crossCode, $rb.selfOk)
  Write-Host ("ProtectedKeyStore — B, A'nın kek.bin'ini açabildi mi: {0} (kod: {1}); B kendi kek.bin'inde: {2}" -f $rk.crossOk, $rk.crossCode, $rk.selfOk)

  foreach ($r in @($rb, $rk)) { if ($r.sid -ne $sidB) { throw "B görevi beklenen kullanıcıyla çalışmadı ($($r.sid))" } }
  if ($rb.crossOk -or $rk.crossOk) { throw 'GÜVENLİK HATASI: ikinci kullanıcı, birinci kullanıcının verisini açtı' }
  if ($rb.crossCode -ne 'UNPROTECT_FAILED') { throw "Ham blob: beklenmeyen kod $($rb.crossCode)" }
  if ($rk.crossCode -ne 'BINDING_MISMATCH') { throw "ProtectedKeyStore: beklenmeyen kod $($rk.crossCode)" }
  if (-not $rb.selfOk) { throw 'B kendi DPAPI blob''unu çözemedi; sonuç yorumlanamaz' }
  if (-not $rk.selfOk) { throw "B kendi kek.bin dosyasını açamadı ($($rk.selfCode)); sonuç yorumlanamaz" }

  # 5. A hâlâ kendi verilerini açabiliyor
  Invoke-Native 'A: ham blob doğrulama' { & $node $probe verify (Join-Path $work 'blob.bin') }
  Invoke-Native 'A: kek.bin doğrulama' { & $node $ksprobe verify (Join-Path $work 'kek-a.bin') }
  Write-Host 'DPAPI kullanıcı izolasyonu (standart kullanıcı; ham blob + ProtectedKeyStore): GEÇTİ'
}
finally {
  $pw = $null
  Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
  if ($batchGranted -and $sidB) { try { [SaklazLsa]::Revoke($sidB, 'SeBatchLogonRight') } catch { Write-Warning 'toplu iş hakkı geri alınamadı' } }
  if ($created) {
    try { $computer.Delete('User', $user) } catch { Write-Warning 'geçici kullanıcı silinemedi' }
    if ($sidB) {
      Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sidB } | ForEach-Object {
        try { Remove-CimInstance -InputObject $_ } catch { Write-Warning 'geçici kullanıcı profili silinemedi' }
      }
    }
  }
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  if ($created -and ([ADSI]::Exists("WinNT://$env:COMPUTERNAME/$user,user"))) { Write-Warning 'UYARI: geçici kullanıcı hâlâ var' }
}
