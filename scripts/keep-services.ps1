# VisionQA Workbench 本地服务守护：确保 8787（API+dist）与 5191（Vite dev）常驻
# 用法：Start-Process -FilePath powershell -ArgumentList '-ExecutionPolicy','Bypass','-File','D:\Projects\creator-canvas-studio\scripts\keep-services.ps1' -WindowStyle Hidden
$ErrorActionPreference = 'SilentlyContinue'
$root = 'D:\Projects\creator-canvas-studio'
$log = Join-Path $root 'data\keeper.log'

function Write-Log($message) {
  $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $message
  Add-Content -Path $log -Value $line -Encoding utf8
}

# 用 HTTP 探测（localhost 会同时覆盖 IPv4/IPv6；vite 常只监听 [::1]）
$http = New-Object System.Net.Http.HttpClient
$http.Timeout = [TimeSpan]::FromSeconds(3)

function Test-Http($port) {
  try {
    $response = $http.GetAsync('http://localhost:' + $port + '/').GetAwaiter().GetResult()
    return $response.IsSuccessStatusCode
  } catch { return $false }
}

# 端口上已有监听（含 IPv6）也算活着，避免重复拉起
function Test-Port($port) {
  foreach ($host in @('127.0.0.1', '::1')) {
    try {
      $client = New-Object System.Net.Sockets.TcpClient
      $async = $client.BeginConnect($host, $port, $null, $null)
      $ok = $async.AsyncWaitHandle.WaitOne(800)
      if ($ok -and $client.Connected) { $client.Close(); return $true }
      $client.Close()
    } catch { }
  }
  return $false
}

function Test-Service($port) {
  if (Test-Port $port) { return $true }
  return (Test-Http $port)
}

function Start-Api {
  Write-Log 'restart api on 8787'
  Start-Process -FilePath 'node' -ArgumentList 'server/index.mjs' -WorkingDirectory $root -WindowStyle Hidden
}

function Start-Dev {
  Write-Log 'restart vite dev on 5191'
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm run dev -- --port 5191 --strictPort' -WorkingDirectory $root -WindowStyle Hidden
}

# 单实例：已有存活 keeper 就退出
$pidFile = Join-Path $root 'data\keeper.pid'
if (Test-Path $pidFile) {
  $existing = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($existing) {
    $proc = Get-Process -Id $existing -ErrorAction SilentlyContinue
    if ($proc) { exit 0 }
  }
}
Set-Content -Path $pidFile -Value $PID -Encoding ascii
Write-Log ('keeper started pid=' + $PID)
$apiFailures = 0
$devFailures = 0
$lastApi = Get-Date
$lastDev = Get-Date
while ($true) {
  $now = Get-Date
  if (Test-Service 8787) { $apiFailures = 0 }
  else {
    $apiFailures++
    if ($apiFailures -ge 2 -and ($now - $lastApi).TotalSeconds -gt 45) { Start-Api; $apiFailures = 0; $lastApi = $now; Start-Sleep -Seconds 8 }
  }
  if (Test-Service 5191) { $devFailures = 0 }
  else {
    $devFailures++
    if ($devFailures -ge 2 -and ($now - $lastDev).TotalSeconds -gt 45) { Start-Dev; $devFailures = 0; $lastDev = $now; Start-Sleep -Seconds 10 }
  }
  Start-Sleep -Seconds 15
}
