# Start the local memory dashboard if it is not already listening.
$port = 8765
$listen = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listen) { "Dashboard already running on $port"; exit 0 }
$p = Start-Process -FilePath 'node' -ArgumentList 'E:\OpenCodeData\memory\dashboard\server.js' -WindowStyle Hidden -PassThru
"Dashboard started: PID $($p.Id) -> http://127.0.0.1:$port"
