# SAKLAZ ajanını Windows oturum açılışında (bu kullanıcı için) arka planda başlatır.
# Yönetici yetkisi gerekmez. Ajan, DPAPI kullanıcı kapsamı nedeniyle bu kullanıcının oturumunda çalışmalıdır.
param([ValidateSet('personal', 'business')][string]$AgentProfile = 'personal')
$ErrorActionPreference = 'Stop'
$name = "SAKLAZ Agent ($AgentProfile)"
$vbs = Join-Path $PSScriptRoot 'saklaz-hidden.vbs'
$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`" run --profile $AgentProfile" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Başlangıç görevi kuruldu: $name"
if (-not $env:SAKLAZ_NO_START) {
  Start-ScheduledTask -TaskName $name
  Write-Host 'Ajan arka planda başlatıldı. Durum: saklaz-agent status'
}
