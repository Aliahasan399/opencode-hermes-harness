# Back up the memory database to E:\OpenCodeData\memory\backups
$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$file = "E:\OpenCodeData\memory\backups\memory-$stamp.sql"
$sql = docker exec opencode-memory-db pg_dump -U opencode_memory -d opencode_memory --no-owner --clean --if-exists
if ($LASTEXITCODE -ne 0) { throw 'pg_dump failed' }
[System.IO.File]::WriteAllText($file, ($sql -join "`n"), [System.Text.UTF8Encoding]::new($false))
"Backup written: $file"
