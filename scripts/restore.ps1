# Restore a memory database backup. Explicit -File and -Force are required.
param(
  [Parameter(Mandatory=$true)][string]$File,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
if (-not $Force) { throw 'Refusing to restore without -Force (this replaces current memory data).' }
if (-not (Test-Path -LiteralPath $File)) { throw "Backup not found: $File" }
$sql = Get-Content -LiteralPath $File -Raw
$sql | docker exec -i opencode-memory-db psql -U opencode_memory -d opencode_memory -v ON_ERROR_STOP=1
if ($LASTEXITCODE -ne 0) { throw 'psql restore failed' }
"Restored from: $File"
