# SAKLAZ AI — Windows ajan paketi (MVP alfa). CI'da (windows-2022) çalışır.
# Önkoşul: pnpm install, DPAPI yerel modülü (build:native) ve ajan paketi (build:dist) derlenmiş olmalı.
# Çıktı: <Out>\saklaz-agent\ (taşınabilir klasör) ve <Out>\saklaz-agent-win-x64.zip
# Paket; Node çalışma zamanını, ajanı, yerel modülleri ve başlangıç görevi betiklerini içerir.
# Gizli değer, hesap bilgisi veya yapılandırma İÇERMEZ (bunlar kurulumdan sonra kullanıcı profilinde oluşur).
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$pkg = Join-Path $Out 'saklaz-agent'
if (Test-Path $pkg) { Remove-Item -Recurse -Force $pkg }
New-Item -ItemType Directory -Path $pkg, (Join-Path $pkg 'dist'), (Join-Path $pkg 'native\build\Release'), (Join-Path $pkg 'node_modules') | Out-Null

Copy-Item (Get-Command node).Source (Join-Path $pkg 'node.exe')
Copy-Item (Join-Path $root 'apps\agent\dist\saklaz-agent.mjs') (Join-Path $pkg 'dist\')
$legal = Join-Path $root 'apps\agent\dist\saklaz-agent.mjs.LEGAL.txt'
if (Test-Path $legal) { Copy-Item $legal (Join-Path $pkg 'dist\') }
Copy-Item (Join-Path $root 'packages\win-keyprotect\native\build\Release\keyprotect.node') (Join-Path $pkg 'native\build\Release\')

# SQLCipher yerel modülü ve çalışma zamanı bağımlılıkları (derleme kaynakları hariç)
$store = Join-Path $root 'node_modules\.pnpm'
function Copy-Pkg([string]$name, [string]$glob) {
  $src = Get-ChildItem -Directory $store -Filter $glob | Select-Object -First 1
  if (-not $src) { throw "paket bulunamadı: $name" }
  $from = Join-Path $src.FullName "node_modules\$name"
  $to = Join-Path $pkg "node_modules\$name"
  robocopy $from $to /E /XD deps src node_modules test /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "kopyalama başarısız: $name" }
}
Copy-Pkg 'better-sqlite3-multiple-ciphers' 'better-sqlite3-multiple-ciphers@*'
Copy-Pkg 'bindings' 'bindings@*'
Copy-Pkg 'file-uri-to-path' 'file-uri-to-path@*'
if (-not (Test-Path (Join-Path $pkg 'node_modules\better-sqlite3-multiple-ciphers\build\Release\better_sqlite3.node'))) { throw 'SQLCipher yerel modülü eksik' }

Copy-Item (Join-Path $PSScriptRoot 'windows\*') $pkg -Recurse
$global:LASTEXITCODE = 0
$zip = Join-Path $Out 'saklaz-agent-win-x64.zip'
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path $pkg -DestinationPath $zip
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
Set-Content -Path "$zip.sha256" -Value "$hash  saklaz-agent-win-x64.zip" -Encoding ascii
Write-Host "Paket: $zip"
Write-Host "SHA-256: $hash"
