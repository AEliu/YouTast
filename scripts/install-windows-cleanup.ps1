$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root '.venv\Scripts\pythonw.exe'
$cleanup = Join-Path $PSScriptRoot 'windows-cleanup.py'
if (-not (Test-Path -LiteralPath $python) -or -not (Test-Path -LiteralPath $cleanup)) { throw 'Executor Python or cleanup script not found' }
$hashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
try { $hash = [System.BitConverter]::ToString($hashAlgorithm.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant()))).Replace('-', '').Substring(0, 8) }
finally { $hashAlgorithm.Dispose() }
$name = "YouTast Cleanup $hash"
$action = New-ScheduledTaskAction -Execute $python -Argument ('"{0}"' -f $cleanup) -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours 6)
$userName = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $userName -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Clean stale YouTast executor cache and abandoned temporary audio' -Force | Out-Null
Start-ScheduledTask -TaskName $name
Write-Output "Scheduled cleanup: $name (every 6 hours while this user is logged in)"
