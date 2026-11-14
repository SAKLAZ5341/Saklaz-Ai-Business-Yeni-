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
      finally {
  $pw = $null
  $problems = @()
  if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 15 -and (Get-ScheduledTask -TaskName $task).State -eq 'Running'; $i++) { Start-Sleep -Seconds 1 }
    Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
    if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) { $problems += 'görev' }
  }
  if ($batchGranted -and $sidB) { try { [SaklazLsa]::Revoke($sidB, 'SeBatchLogonRight') } catch { $problems += 'toplu iş hakkı' } }
  if ($sidB) {
    # Profil, kullanıcı silinmeden ÖNCE kaldırılır; oturum kapanışı birkaç saniye sürebildiği için yeniden denenir.
    $removed = $false
    for ($i = 0; $i -lt 20 -and -not $removed; $i++) {
      $prof = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sidB }
      if (-not $prof) { $removed = $true; break }
      try { $prof | Remove-CimInstance -ErrorAction Stop } catch { Start-Sleep -Seconds 2 }
    }
    if (-not $removed -and (Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sidB })) { $problems += 'kullanıcı profili' }
  }
  if ($created) {
    try { $computer.Delete('User', $user) } catch { }
    # Kullanıcı yoksa ADSI "bulunamadı" istisnası atar: beklenen durum budur.
    $still = try { [ADSI]::Exists("WinNT://$env:COMPUTERNAME/$user,user") } catch { $false }
    if ($still) { $problems += 'kullanıcı' }
  }
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  if (Test-Path $work) { $problems += 'çalışma klasörü' }
  if ($problems.Count -gt 0) { throw ("Temizlik tamamlanamadı: " + ($problems -join ', ')) }
  Write-Host 'Temizlik doğrulandı: görev, toplu iş hakkı, kullanıcı profili, geçici kullanıcı ve dosyalar kaldırıldı'
}
