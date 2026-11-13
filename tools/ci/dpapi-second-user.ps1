# SAKLAZ AI — DPAPI kullanıcı izolasyonu testi (Sprint 3 A3, test planı T-A3-22).
#
# YALNIZCA GitHub Actions'ın geçici Windows sanal makinesinde çalışır (iş yönetici olarak koşar).
#   1. İş kullanıcısı (A) rastgele bir sırrı DPAPI ile korur.
#   2. Geçici, rastgele parolalı ikinci bir yerel kullanıcı (B) oluşturulur.
#   3. B adına, profili yüklenerek (zamanlanmış görev), A'nın blob'u çözülmeye çalışılır.
#   Beklenen: B, A'nın blob'unu ÇÖZEMEZ (UNPROTECT_FAILED); ama kendi verisini çözebilir (DPAPI B
#   için çalışıyor, yani başarısızlığın nedeni izolasyondur). A ise kendi blob'unu hâlâ çözebilir.
#
# B'nin parolası yalnızca bu betiğin belleğinde bulunur; dosyaya, günlüğe veya depoya yazılmaz.
# Düz metin hiçbir yerde yazılmaz (probe.mjs yalnızca SHA-256 özeti yazar). Sonunda görev ve
# kullanıcı silinir.
$ErrorActionPreference = 'Stop'
if (-not $env:GITHUB_ACTIONS) { throw 'Bu betik yalnızca CI içindir (yerel kullanıcı oluşturur).' }

$root  = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$kp    = Join-Path $root 'packages\win-keyprotect'
$probe = Join-Path $kp 'scripts\probe.mjs'
$node  = (Get-Command node).Source
$work  = Join-Path $env:RUNNER_TEMP ("dpapi-" + [guid]::NewGuid().ToString('N'))
$user  = 'saklazdpapit2'
$task  = 'saklaz-dpapi-izolasyon'
New-Item -ItemType Directory -Path $work | Out-Null

# Yerel komutların çıkış kodu her adımda denetlenir (hata zincirleme ilerlemesin).
function Invoke-Checked([string]$what, [scriptblock]$cmd) {
  & $cmd | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "$what başarısız (çıkış $LASTEXITCODE)" }
}

$created = $false
try {
  # 1. A: koru (aynı süreçte gidiş-dönüş de doğrulanır)
  & $node $probe protect (Join-Path $work 'blob.bin')
  if ($LASTEXITCODE -ne 0) { throw 'A: protect başarısız' }
  $sidA = (& $node -e "console.log(require('$($kp.Replace('\','\\'))\\native\\build\\Release\\keyprotect.node').userSid())").Trim()

  # 2. B: geçici yerel kullanıcı. Toplu iş oturumu (zamanlanmış görev) hakkı için Administrators
  #    grubuna eklenir. Not: Yönetici olması A'nın DPAPI verisini çözmesine YETMEZ; test bunu da gösterir.
  $chars = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  # 14 karakter: daha uzun parolada "net user" etkileşimli onay ister (CI'da yanıtlanamaz).
  $bytes = New-Object byte[] 10; $rng.GetBytes($bytes)
  $pw = 'Aa1!' + (-join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] }))
  Invoke-Checked 'kullanıcı oluşturma' { net user $user $pw /add /expires:never }
  $created = $true
  Invoke-Checked 'Administrators grubuna ekleme' { net localgroup Administrators $user /add }
  Invoke-Checked 'çalışma klasörü izni' { icacls $work /grant "${user}:(OI)(CI)M" }
  Invoke-Checked 'paket okuma izni' { icacls $kp /grant "${user}:(OI)(CI)RX" /T /C /Q }

  # 3. B adına çalıştır (komut satırı uzunluk sınırı için .cmd sarmalayıcı)
  $result = Join-Path $work 'result-b.json'
  $cmd = Join-Path $work 'run-b.cmd'
  # /tr değerinde gömülü tırnak kullanılmaz (pwsh kaçışlar, schtasks yolu bulamaz); yolda boşluk olmamalı.
  if ($cmd -match '\s') { throw "Görev yolu boşluk içeriyor: $cmd" }
  Set-Content -Path $cmd -Encoding ascii -Value "`"$node`" `"$probe`" cross `"$(Join-Path $work 'blob.bin')`" `"$result`" > `"$(Join-Path $work 'b.log')`" 2>&1"
  Invoke-Checked 'görev oluşturma' { schtasks /create /tn $task /ru $user /rp $pw /sc once /st 23:59 /tr $cmd /rl highest /f }
  Invoke-Checked 'görevi çalıştırma' { schtasks /run /tn $task }
  $deadline = (Get-Date).AddSeconds(180)
  while (-not (Test-Path $result) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
  if (-not (Test-Path $result)) {
    $log = if (Test-Path (Join-Path $work 'b.log')) { Get-Content (Join-Path $work 'b.log') -Raw } else { '(günlük yok)' }
    schtasks /query /tn $task /v /fo list | Select-String 'Last Result|Status'
    throw "B adına çalıştırılan görev sonuç üretmedi. Günlük: $log"
  }
  $r = Get-Content $result -Raw | ConvertFrom-Json
  Write-Host ("A SID: {0}`nB SID: {1}`nB, A'nın blob'unu çözebildi mi: {2} (kod: {3})`nB kendi verisinde DPAPI: {4}" -f $sidA, $r.sid, $r.crossOk, $r.crossCode, $r.selfOk)

  if ($r.sid -eq $sidA) { throw 'B görevi A kullanıcısı olarak çalıştı; test geçersiz' }
  if ($r.crossOk) { throw 'GÜVENLİK HATASI: ikinci kullanıcı, birinci kullanıcının DPAPI verisini çözdü' }
  if ($r.crossCode -ne 'UNPROTECT_FAILED') { throw "Beklenmeyen hata kodu: $($r.crossCode)" }
  if (-not $r.selfOk) { throw 'B kendi verisinde DPAPI çalıştıramadı; izolasyon sonucu yorumlanamaz' }

  # 4. A hâlâ kendi verisini çözebiliyor
  & $node $probe verify (Join-Path $work 'blob.bin')
  if ($LASTEXITCODE -ne 0) { throw 'A: verify başarısız' }
  Write-Host 'DPAPI kullanıcı izolasyonu: GEÇTİ'
}
finally {
  schtasks /delete /tn $task /f 2>$null | Out-Null
  if ($created) { net user $user /delete | Out-Null }
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
