# Double-click Start-Sidecar.cmd, or pass a quoted workspace path as its first argument.
# Optional parameters: -Port 4092, -DshCli <path>, -Doctor.
# This script uses existing runtimes; it installs nothing and edits no DSH configuration.
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Workspace,
    [ValidateRange(1024, 65535)]
    [int]$Port = 3082,
    [string]$DshCli,
    [switch]$Doctor
)

$ErrorActionPreference = 'Stop'
$sidecarRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Find-SidecarNode {
    $candidates = @()
    if ($env:DSH_SIDECAR_NODE) {
        $candidates += $env:DSH_SIDECAR_NODE
    } else {
        if ($env:LOCALAPPDATA) {
            $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeekHarness\runtime\node.exe')
            $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeekHarness\runtime\bin\node.exe')
        }
        $pathNodes = @(Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue)
        $candidates += @($pathNodes | ForEach-Object { $_.Source })
        if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe') }
        if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe') }
    }

    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $resolved = (Resolve-Path -LiteralPath $candidate).Path
        $version = & $resolved --version 2>$null
        if ($LASTEXITCODE -eq 0 -and "$version" -match '^v(\d+)\.') {
            if ([int]$Matches[1] -ge 22) { return $resolved }
        }
    }
    throw 'Node.js 22 or later was not found. Install a supported Node runtime or set DSH_SIDECAR_NODE to an existing node.exe.'
}

try {
    $sidecarNode = Find-SidecarNode
    $launchArgs = @((Join-Path $sidecarRoot 'scripts\start.mjs'), '--open', '--port', [string]$Port)
    if ($Workspace) { $launchArgs += @('--workspace', [System.IO.Path]::GetFullPath($Workspace)) }
    if ($DshCli) { $launchArgs += @('--dsh-cli', [System.IO.Path]::GetFullPath($DshCli)) }
    if ($Doctor) { $launchArgs += '--doctor' }
    Write-Host "Using Node: $sidecarNode"
    & $sidecarNode @launchArgs
    exit $LASTEXITCODE
} catch {
    Write-Error $_.Exception.Message -ErrorAction Continue
    exit 1
}
