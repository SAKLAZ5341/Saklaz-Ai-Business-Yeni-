# Başlangıç görevini durdurur ve kaldırır. Anahtarlar ve veriler SİLİNMEZ
# (%LOCALAPPDATA%\SAKLAZ\agent-<profil>; silmek için klasörü elle kaldırın).
param([ValidateSet('personal', 'business')][string]$AgentProfile = 'personal')
$name = "SAKLAZ Agent ($AgentProfile)"
Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Başlangıç görevi kaldırıldı: $name"
