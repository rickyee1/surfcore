[CmdletBinding()]
param(
    [ValidateSet('start', 'status', 'stop', 'restart')][string]$Action = 'status',
    [ValidateRange(1024, 65535)][int]$MemoryPort = 3210,
    [ValidateRange(1024, 65535)][int]$DshPort = 3211,
    [string]$DshCli = '',
    [switch]$OpenBrowser,
    [switch]$Json,
    [ValidateSet('', 'memory', 'dsh')][string]$RunService = '',
    [string]$InstanceId = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$deploymentDir = Join-Path $repoRoot '.local/deployment'
$stateFile = Join-Path $deploymentDir 'state.json'
$dshHomePath = Join-Path $repoRoot '.local/dsh'
$pythonPath = Join-Path $repoRoot '.venv/Scripts/python.exe'
$devEntry = Join-Path $repoRoot 'scripts/local-capabilities-dev.mjs'

function Fail([string]$Code, [string]$Message, [string]$Hint) {
    $exception = [Exception]::new($Message)
    $exception.Data['code'] = $Code; $exception.Data['hint'] = $Hint
    throw $exception
}
function ProcessIdentity([int]$ProcessId) {
    $item = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    if (-not $item -or -not $item.CommandLine -or -not $item.ExecutablePath) { return $null }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($item.CommandLine))).Replace('-', '') }
    finally { $sha.Dispose() }
    return [pscustomobject]@{ pid = [int]$item.ProcessId; parent = [int]$item.ParentProcessId; created = $item.CreationDate.ToUniversalTime().ToString('o'); executable = [string]$item.ExecutablePath; commandHash = $hash }
}
function IdentityMatches($Expected) {
    if (-not $Expected) { return $false }
    $actual = ProcessIdentity ([int]$Expected.pid)
    return $actual -and ([datetime]$actual.created).ToUniversalTime().Ticks -eq ([datetime]$Expected.created).ToUniversalTime().Ticks -and $actual.executable -eq $Expected.executable -and $actual.commandHash -eq $Expected.commandHash
}
function ReadState {
    if (-not (Test-Path -LiteralPath $stateFile)) { return @{ schema = 1; root = $repoRoot; services = @{} } }
    try { $value = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json -AsHashtable }
    catch { Fail 'STATE_INVALID' '部署进程记录无法读取，未执行任何停止操作。' '检查 .local/deployment/state.json；保留原文件并先确认占用进程身份。' }
    if ($value.schema -ne 1 -or $value.root -ne $repoRoot) { Fail 'STATE_INVALID' '部署记录不属于当前仓库。' '使用原仓库脚本管理已有进程。' }
    return $value
}
function ResolveDshCli($State) {
    $candidate = $DshCli
    if ([string]::IsNullOrWhiteSpace($candidate)) { $candidate = $env:SURFCORE_DSH_CLI }
    if ([string]::IsNullOrWhiteSpace($candidate) -and $State.ContainsKey('dshCli')) { $candidate = [string]$State.dshCli }
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        $command = Get-Command dsh.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) { $candidate = $command.Source }
    }
    if ([string]::IsNullOrWhiteSpace($candidate) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        Fail 'DEPENDENCY_MISSING' '未找到官方 DSH CLI。' "首次 start 请传入 -DshCli '<DSH安装目录>\resources\runtime\cli\bin\dsh.cmd'，或设置当前进程 SURFCORE_DSH_CLI；有效路径将保存在仓库 .local 供后续复用。"
    }
    return [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $candidate).ProviderPath)
}
function SaveState($State) {
    [IO.Directory]::CreateDirectory($deploymentDir) | Out-Null
    if (Test-Path -LiteralPath $stateFile) { Copy-Item -LiteralPath $stateFile -Destination (Join-Path $deploymentDir 'state.previous.json') -Force }
    $temporary = Join-Path $deploymentDir 'state.pending.json'
    $State | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $stateFile -Force
}
function Listeners([int]$Port) {
    return @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq $Port)
}
function IsDescendant([int]$Candidate, $Ancestor) {
    $visited = @{}
    for ($depth = 0; $depth -lt 16 -and $Candidate -gt 0; $depth++) {
        if ($Candidate -eq [int]$Ancestor.pid) { return (IdentityMatches $Ancestor) }
        if ($visited.ContainsKey($Candidate)) { return $false }
        $visited[$Candidate] = $true
        $current = ProcessIdentity $Candidate
        if (-not $current -or [datetime]$current.created -lt [datetime]$Ancestor.created) { return $false }
        $Candidate = $current.parent
    }
    return $false
}
function ServiceStatus([string]$Name, [int]$Port, $State) {
    $record = $State.services[$Name]
    $listeners = @(Listeners $Port)
    $ownedLauncher = $record -and (IdentityMatches $record.launcher)
    $ownedListener = $record -and $record.listener -and (IdentityMatches $record.listener)
    $valid = $listeners.Count -gt 0
    foreach ($listener in $listeners) {
        $same = $record -and [int]$record.port -eq $Port -and $listener.LocalAddress -eq '127.0.0.1' -and (
            ($ownedListener -and [int]$listener.OwningProcess -eq [int]$record.listener.pid) -or
            ($ownedLauncher -and (IsDescendant ([int]$listener.OwningProcess) $record.launcher)))
        if (-not $same) { $valid = $false }
    }
    $status = if ($listeners.Count -and -not $valid) { 'unmanaged-port' } elseif ($valid) { 'running' } elseif ($ownedLauncher -or $ownedListener) { 'not-ready' } else { 'stopped' }
    return [pscustomobject]@{ service = $Name; port = $Port; status = $status; managed = [bool]($ownedLauncher -or $ownedListener); pids = @($listeners | ForEach-Object { [int]$_.OwningProcess }); url = "http://127.0.0.1:$Port/" }
}
function StopOwnedTree($RootIdentity) {
    if (-not (IdentityMatches $RootIdentity)) { return }
    $identities = @($RootIdentity)
    for ($cursor = 0; $cursor -lt $identities.Count; $cursor++) {
        $parentIdentity = $identities[$cursor]
        if (-not (IdentityMatches $parentIdentity)) { continue }
        foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($parentIdentity.pid)")) {
            $identity = ProcessIdentity ([int]$child.ProcessId)
            if ($identity -and [datetime]$identity.created -ge [datetime]$parentIdentity.created -and ($identities.pid -notcontains $identity.pid)) { $identities += $identity }
        }
    }
    [array]::Reverse($identities)
    foreach ($identity in $identities) {
        if (IdentityMatches $identity) { Stop-Process -Id ([int]$identity.pid) -Force -ErrorAction Stop }
    }
}
function StopServices($State) {
    foreach ($name in @('dsh', 'memory')) {
        $record = $State.services[$name]
        if (-not $record) { continue }
        # Recorded child identity remains sufficient if its launcher has exited.
        if ($record.listener) { StopOwnedTree $record.listener }
        StopOwnedTree $record.launcher
    }
    # Keep process records, logs, databases, settings and sessions for verification/restart.
}
function StartService([string]$Name, [int]$Port, $State) {
    $current = ServiceStatus $Name $Port $State
    if ($current.status -eq 'running') { return }
    if ($current.status -ne 'stopped') { Fail 'PORT_UNAVAILABLE' "$Name 端口 $Port 状态为 $($current.status)，未终止任何未知进程。" '先运行 status 并确认占用；仅对脚本管理的进程使用 restart。' }
    $instance = [guid]::NewGuid().ToString()
    $logDir = Join-Path $deploymentDir 'logs'
    [IO.Directory]::CreateDirectory($logDir) | Out-Null
    # Encoded command contains only paths/options and a random ownership marker, never login credentials.
    $escape = { param($value) "'" + ([string]$value).Replace("'", "''") + "'" }
    $command = "& $(& $escape $PSCommandPath) -RunService $Name -InstanceId '$instance' -MemoryPort $MemoryPort -DshPort $DshPort -DshCli $(& $escape $DshCli)"
    if ($OpenBrowser) { $command += ' -OpenBrowser' }
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $shellPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
    $process = Start-Process -FilePath $shellPath -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded) -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir "$Name-$instance.out.log") -RedirectStandardError (Join-Path $logDir "$Name-$instance.err.log") -PassThru
    $identity = $null
    for ($attempt = 0; $attempt -lt 10 -and -not $identity; $attempt++) { $identity = ProcessIdentity $process.Id; if (-not $identity) { Start-Sleep -Milliseconds 50 } }
    if (-not $identity) { Fail 'LAUNCH_FAILED' "$Name 启动器提前退出。" '检查 .local/deployment/logs 中本次日志，勿复制其中凭据。' }
    $State.services[$Name] = @{ port = $Port; instance = $instance; launcher = $identity; listener = $null }
    SaveState $State
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        $current = ServiceStatus $Name $Port $State
        if ($current.status -eq 'running') {
            $State.services[$Name].listener = ProcessIdentity ([int]$current.pids[0]); SaveState $State; return
        }
        if ($current.status -eq 'unmanaged-port') { Fail 'PORT_UNAVAILABLE' "$Name 启动期间端口被其他进程占用。" '运行 status 确认；脚本没有终止未知进程。' }
        if (-not (IdentityMatches $identity)) { break }
        Start-Sleep -Milliseconds 500
    }
    Fail 'START_NOT_READY' "$Name 未在 30 秒内建立监听；已保存进程身份以便检查和停止。" '运行 status；检查 .local/deployment/logs，再用 stop 停止本脚本实例。'
}
try {
    if ($RunService) {
        if (-not [guid]::TryParse($InstanceId, [ref]([guid]::Empty))) { Fail 'INSTANCE_INVALID' '缺少内部启动实例标识。' '使用 start 启动。' }
        $env:DSH_HOME = $dshHomePath
        $env:SURFCORE_LOCAL_PYTHON = $pythonPath
        Set-Location -LiteralPath $repoRoot
        if ($RunService -eq 'memory') {
            $env:SURFCORE_LOCAL_PORT = [string]$MemoryPort
            & (Get-Command node.exe -ErrorAction Stop).Source $devEntry
        } else {
            $cliArgs = @('--profile', 'web', '--host', '127.0.0.1', '--port', [string]$DshPort)
            if (-not $OpenBrowser) { $cliArgs += '--no-open' }
            & $DshCli @cliArgs
        }
        exit $LASTEXITCODE
    }
    if ($MemoryPort -eq $DshPort) { Fail 'PORT_CONFLICT' '两个服务不能使用相同端口。' '为 MemoryPort 和 DshPort 指定不同端口。' }
    [IO.Directory]::CreateDirectory($deploymentDir) | Out-Null
    $lock = $null
    try { $lock = [IO.File]::Open((Join-Path $deploymentDir 'operation.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch { Fail 'DEPLOYMENT_BUSY' '另一条部署命令正在运行。' '等前一条命令完成后重试。' }
    try {
        $state = ReadState
        if ($Action -in @('start', 'restart')) {
            $DshCli = ResolveDshCli $state
            if (-not (Test-Path -LiteralPath $pythonPath) -or -not (Test-Path -LiteralPath $DshCli) -or -not (Test-Path -LiteralPath $devEntry)) { Fail 'DEPENDENCY_MISSING' '缺少 Python、DSH CLI 或本地管理入口。' '检查仓库 .venv 和 DshCli 参数，不要改用用户默认 DSH_HOME。' }
            Get-Command node.exe, pwsh.exe -ErrorAction Stop | Out-Null
            & $pythonPath -c 'import sqlcipher3' 2>$null
            if ($LASTEXITCODE -ne 0) { Fail 'SQLCIPHER_UNAVAILABLE' '隔离 Python 无法加载 SQLCipher。' '在仓库 .venv 安装锁定依赖后重试。' }
            if (-not (Test-Path -LiteralPath $dshHomePath -PathType Container)) { Fail 'DSH_HOME_UNPREPARED' '仓库隔离 DSH_HOME 尚未准备。' '先按部署文档注册插件到 .local/dsh；脚本不会读取用户 ~/.dsh。' }
            foreach ($spec in @(@('memory', $MemoryPort), @('dsh', $DshPort))) {
                if ((ServiceStatus $spec[0] $spec[1] $state).status -eq 'unmanaged-port') { Fail 'PORT_UNAVAILABLE' "$($spec[0]) 端口 $($spec[1]) 由未知进程占用，未启动或停止任何服务。" '运行 status 确认占用进程，调整端口或由其拥有者停止。' }
            }
        }
        if ($Action -in @('start', 'restart')) { $state['dshCli'] = $DshCli; SaveState $state }
        if ($Action -in @('stop', 'restart')) { StopServices $state }
        if ($Action -in @('start', 'restart')) { StartService 'memory' $MemoryPort $state; StartService 'dsh' $DshPort $state }
        $services = @((ServiceStatus 'memory' $MemoryPort $state), (ServiceStatus 'dsh' $DshPort $state))
        $unmanaged = @($services | Where-Object status -eq 'unmanaged-port')
        $result = @{ ok = $unmanaged.Count -eq 0; action = $Action; root = $repoRoot; dshHome = $dshHomePath; services = $services }
        if ($unmanaged.Count) { $result.code = 'PORT_UNAVAILABLE'; $result.error = '发现非本脚本管理的端口监听。'; $result.hint = '由原进程拥有者处理占用；本脚本不会接管或终止它。' }
        $result | ConvertTo-Json -Depth 8
        if ($unmanaged.Count) { exit 1 }
    } finally { if ($lock) { $lock.Dispose() } }
} catch {
    $code = if ($_.Exception.Data['code']) { $_.Exception.Data['code'] } else { 'DEPLOYMENT_FAILED' }
    $hint = if ($_.Exception.Data['hint']) { $_.Exception.Data['hint'] } else { '确认依赖和进程状态后重试；未确认身份的进程不会被终止。' }
    @{ ok = $false; code = $code; error = $_.Exception.Message; hint = $hint } | ConvertTo-Json
    exit 1
}
