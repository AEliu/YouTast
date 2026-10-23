param([switch]$Stop, [switch]$RemoveAutoStart)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskPython = Join-Path $taskRoot '.venv\Scripts\pythonw.exe'
$taskRunner = Join-Path $taskRoot 'scripts\windows-runner.py'
$taskConfig = Join-Path $taskRoot '.secrets\windows-executor.env'
$taskStateDir = Join-Path $taskRoot '.wrangler\windows-executor'
$taskStateFile = Join-Path $taskStateDir 'process.json'
$taskHashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
try { $taskHash = [System.BitConverter]::ToString($taskHashAlgorithm.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($taskRoot.ToLowerInvariant()))).Replace('-', '').Substring(0, 8) }
finally { $taskHashAlgorithm.Dispose() }
$taskName = "YouTast Executor $taskHash"
if ($Stop) {
    $taskExisting = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($taskExisting) { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $taskStateFile) {
        $taskState = Get-Content -LiteralPath $taskStateFile -Raw | ConvertFrom-Json
        $taskPid = [int]$taskState.pid
        $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$taskPid" -ErrorAction SilentlyContinue
        if ($taskProcess) {
            if (-not $taskProcess.CommandLine -or $taskProcess.CommandLine.IndexOf($taskRunner, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'Refusing to stop an unrelated process' }
            & taskkill.exe /PID $taskPid /T /F | Out-Null
        }
    }
    if ($RemoveAutoStart -and $taskExisting) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
    Write-Output "Stopped executor: $taskName"
    exit 0
}
if (-not (Test-Path -LiteralPath $taskPython) -or -not (Test-Path -LiteralPath $taskConfig)) { throw 'Create the virtualenv and private Windows executor configuration first' }
New-Item -ItemType Directory -Path $taskStateDir -Force | Out-Null
$taskArguments = '"{0}" --config "{1}"' -f $taskRunner, $taskConfig
$taskAutoStart = $false
try {
    $taskUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $taskAction = New-ScheduledTaskAction -Execute $taskPython -Argument $taskArguments -WorkingDirectory $taskRoot
    $taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $taskUser
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
    $taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Description "YouTast outbound executor for $taskRoot" -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    $taskAutoStart = $true
    Write-Output "Configured login startup and background execution: $taskName"
} catch {
    Write-Warning "Login startup was not installed: $($_.Exception.Message)"
    Start-Process -FilePath $taskPython -ArgumentList $taskArguments -WorkingDirectory $taskRoot -WindowStyle Hidden | Out-Null
    Write-Output 'Started a hidden process for the current session.'
}
@{ task_name=$taskName; auto_start=$taskAutoStart; root=$taskRoot; configured_at=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskStateDir 'installation.json') -Encoding UTF8
Write-Output "Logs: $(Join-Path $taskStateDir 'executor.log')"
