# Isolated safety checks: no DSH/DB startup and no access to the user's .dsh.
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$evidence = Join-Path $repoRoot ('.local/deployment-tests/' + [guid]::NewGuid())
$fixture = Join-Path $evidence 'fixture'
[IO.Directory]::CreateDirectory((Join-Path $fixture 'scripts')) | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'local-deployment.ps1') -Destination (Join-Path $fixture 'scripts/local-deployment.ps1')
$script = Join-Path $fixture 'scripts/local-deployment.ps1'
$tokens = $null; $errors = $null
[Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count) { throw "Parser errors: $errors" }
$count = 1
$checks = @('PowerShell parser accepts deployment script')
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }
function Check($Name) { $script:count++; $script:checks += $Name; Write-Host "PASS $Name" }
function Identity([int]$ProcessId) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId"
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($p.CommandLine))).Replace('-', '') }
    finally { $sha.Dispose() }
    return @{ pid = $ProcessId; parent = [int]$p.ParentProcessId; created = $p.CreationDate.ToUniversalTime().ToString('o'); executable = $p.ExecutablePath; commandHash = $hash }
}
function InvokeFixture([string]$Action) {
    $output = & pwsh -NoProfile -File $script $Action -MemoryPort $script:memoryPort -DshPort $script:dshPort -Json
    $exit = $LASTEXITCODE
    return @{ exit = $exit; value = (($output -join "`n") | ConvertFrom-Json) }
}
# Exercise actual resolver/save functions without starting any runtime or database.
& {
    $functionAst = [Management.Automation.Language.Parser]::ParseFile($script, [ref]$null, [ref]$null)
    foreach ($name in @('Fail', 'ResolveDshCli', 'SaveState')) {
        $definition = $functionAst.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
        Invoke-Expression $definition.Extent.Text
    }
    $deploymentDir = Join-Path $fixture '.local/resolver'
    $stateFile = Join-Path $deploymentDir 'state.json'
    $cliDirectory = Join-Path $fixture 'fake CLI'
    [IO.Directory]::CreateDirectory($cliDirectory) | Out-Null
    $envCli = Join-Path $cliDirectory 'dsh.cmd'
    $explicitCli = Join-Path $cliDirectory 'explicit.cmd'
    '@exit /b 0' | Set-Content -LiteralPath $envCli
    '@exit /b 0' | Set-Content -LiteralPath $explicitCli
    $oldCli = $env:SURFCORE_DSH_CLI; $oldPath = $env:PATH
    try {
        $env:SURFCORE_DSH_CLI = $envCli
        $DshCli = $explicitCli
        Assert ((ResolveDshCli @{ dshCli = $envCli }) -eq $explicitCli) 'Explicit CLI must override environment/state.'
        $DshCli = ''
        Assert ((ResolveDshCli @{ dshCli = $explicitCli }) -eq $envCli) 'Current process environment must override persisted CLI.'
        Check 'explicit CLI and process environment have documented priority'
        SaveState @{ schema = 1; root = $fixture; services = @{}; dshCli = $explicitCli }
        $persisted = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json -AsHashtable
        $env:SURFCORE_DSH_CLI = $null
        Assert ((ResolveDshCli $persisted) -eq $explicitCli) 'CLI path must survive state roundtrip without parameters.'
        Check 'persisted private CLI path is reusable without arguments'
        $env:PATH = $cliDirectory
        Assert ((ResolveDshCli @{}) -eq $envCli) 'PATH dsh.cmd must be discovered when no configuration exists.'
        Check 'PATH discovery finds installed command without a hardcoded machine path'
        $env:PATH = ''
        $failure = $null
        try { ResolveDshCli @{} | Out-Null } catch { $failure = $_.Exception }
        Assert ($failure -and $failure.Data['code'] -eq 'DEPENDENCY_MISSING' -and $failure.Data['hint']) 'Missing CLI must have DEPENDENCY_MISSING plus hint.'
        Check 'missing CLI gives actionable DEPENDENCY_MISSING'
    } finally { $env:SURFCORE_DSH_CLI = $oldCli; $env:PATH = $oldPath }
}
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$spare = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start(); $spare.Start()
$memoryPort = $listener.LocalEndpoint.Port; $dshPort = $spare.LocalEndpoint.Port
$spare.Stop()
$owned = $null; $unrelated = $null
try {
    $reply = InvokeFixture 'status'
    Assert ($reply.exit -eq 1 -and $reply.value.code -eq 'PORT_UNAVAILABLE') 'Unknown listener must be a visible failure.'
    Assert ($reply.value.hint -and $reply.value.services[0].status -eq 'unmanaged-port') 'Unknown listener must provide a hint.'
    Check 'status reports unknown listener with code/error/hint without adopting it'
    $listener.Stop()
    $shell = (Get-Command pwsh.exe).Source
    $marker = [guid]::NewGuid().ToString()
    $owned = Start-Process -FilePath $shell -ArgumentList @('-NoProfile', '-Command', "Start-Sleep -Seconds 120 # owned-$marker") -WindowStyle Hidden -PassThru
    $unrelated = Start-Process -FilePath $shell -ArgumentList @('-NoProfile', '-Command', "Start-Sleep -Seconds 120 # unrelated-$marker") -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 150
    $ownedIdentity = Identity $owned.Id
    $reusedIdentity = Identity $unrelated.Id
    $reusedIdentity.created = ([datetime]$reusedIdentity.created).AddMinutes(-1).ToString('o')
    $stateDir = Join-Path $fixture '.local/deployment'
    [IO.Directory]::CreateDirectory($stateDir) | Out-Null
    $state = @{ schema = 1; root = $fixture; services = @{
        memory = @{ port = $memoryPort; instance = 'fixture-reused'; launcher = $reusedIdentity; listener = $null }
        dsh = @{ port = $dshPort; instance = 'fixture-owned'; launcher = $ownedIdentity; listener = $null }
    } }
    $state | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $stateDir 'state.json') -Encoding utf8
    $sentinel = Join-Path $fixture '.local/data-preserve.txt'
    'Do not remove persistent data' | Set-Content -LiteralPath $sentinel
    $before = (Get-FileHash -LiteralPath $sentinel).Hash
    $reply = InvokeFixture 'stop'
    Assert ($reply.exit -eq 0 -and $reply.value.ok) 'Stop should finish for verified fixture process.'
    Assert (-not (Get-Process -Id $owned.Id -ErrorAction SilentlyContinue)) 'Verified owned process must stop.'
    Assert ([bool](Get-Process -Id $unrelated.Id -ErrorAction SilentlyContinue)) 'PID creation mismatch must never kill unrelated process.'
    Check 'stop terminates verified process and refuses simulated PID reuse'
    Assert ((Get-FileHash -LiteralPath $sentinel).Hash -eq $before) 'Stop must preserve data.'
    Assert (Test-Path -LiteralPath (Join-Path $stateDir 'state.json')) 'Stop must preserve identity evidence.'
    Check 'stop preserves data and identity records'
    $stream = [IO.File]::Open((Join-Path $stateDir 'operation.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    try {
        $reply = InvokeFixture 'status'
        Assert ($reply.exit -eq 1 -and $reply.value.code -eq 'DEPLOYMENT_BUSY' -and $reply.value.hint) 'Concurrent commands must fail visibly.'
    } finally { $stream.Dispose() }
    Check 'concurrent operation lock returns actionable failure'
    '{broken' | Set-Content -LiteralPath (Join-Path $stateDir 'state.json')
    $reply = InvokeFixture 'stop'
    Assert ($reply.exit -eq 1 -and $reply.value.code -eq 'STATE_INVALID' -and $reply.value.hint) 'Corrupt state must fail closed.'
    Assert ([bool](Get-Process -Id $unrelated.Id -ErrorAction SilentlyContinue)) 'Corrupt state must not terminate unknown processes.'
    Check 'corrupt process records fail closed without killing anything'
    $result = @{ passed = $count; checks = $checks; realLifecycle = 'NOT_VERIFIED; controller will validate default services after stopping old launchers' }
    $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidence 'results.json') -Encoding utf8
    Write-Host "PASS $count deployment safety checks; evidence $evidence"
} finally {
    $listener.Stop(); $spare.Stop()
    # Cleanup only fixture processes, preserving evidence files.
    foreach ($process in @($owned, $unrelated)) {
        if ($process -and -not $process.HasExited) { Stop-Process -InputObject $process -Force -ErrorAction SilentlyContinue }
    }
}
