<#
.SYNOPSIS
Thin PowerShell wrapper for the OpenCode Harness installer.
.DESCRIPTION
Forwards arguments to `node installer/bootstrap/install.mjs` without changing their meaning.
No Git operations, no dependency installs, no environment values are read here.
.EXAMPLE
powershell -File scripts/setup/setup.ps1 -Target . -Capabilities memory,learning,agents -DryRun
.EXAMPLE
powershell -File scripts/setup/setup.ps1 --target . --capabilities memory,learning,agents --dry-run
#>
param(
  [string]$Target,
  [string]$Capabilities,
  [string]$Mode,
  [string]$Engine,
  [switch]$DryRun,
  [switch]$Apply,
  [switch]$Yes,
  [switch]$Uninstall,
  [switch]$Doctor,
  [switch]$Validate,
  [switch]$InjectAgents,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)

$ErrorActionPreference = 'Stop'
$installer = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\installer\bootstrap\install.mjs'))
if (-not (Test-Path -LiteralPath $installer)) {
  Write-Error "Installer not found: $installer"
  exit 1
}

$forward = @()
if ($Target) { $forward += @('--target', $Target) }
if ($Capabilities) { $forward += @('--capabilities', $Capabilities) }
if ($Mode) { $forward += @('--mode', $Mode) }
if ($Engine) { $forward += @('--engine', $Engine) }
if ($DryRun) { $forward += '--dry-run' }
if ($Apply) { $forward += '--apply' }
if ($Yes) { $forward += '--yes' }
if ($Uninstall) { $forward += '--uninstall' }
if ($Doctor) { $forward += '--doctor' }
if ($Validate) { $forward += '--validate' }
if ($InjectAgents) { $forward += '--inject-agents' }
$forward += $Arguments

& node $installer @forward
exit $LASTEXITCODE
