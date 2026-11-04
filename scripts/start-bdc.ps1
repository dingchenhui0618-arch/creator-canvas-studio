# BD Canvas 三端口启动脚本（BD Canvas 源码不随本仓库分发，本脚本只负责把它跑起来）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\start-bdc.ps1
# 可选：-Root 指定 BD Canvas 解压目录，默认 D:\Projects\bd-canvas
param(
  [string]$Root = "D:\Projects\bd-canvas"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path (Join-Path $Root "server_v2.py"))) {
  Write-Host "找不到 BD Canvas：$Root（缺 server_v2.py）。先把部署包解压到该目录。" -ForegroundColor Red
  exit 1
}

$py = Join-Path $Root "python\python.exe"
if (-not (Test-Path $py)) {
  $py = "python"
  Write-Host "项目内没有 python\python.exe，回退到 PATH 里的 python。" -ForegroundColor Yellow
}

$logs = Join-Path $Root "logs"
New-Item -ItemType Directory -Force -Path $logs | Out-Null

function Test-Listening([int]$Port) {
  $hit = netstat -ano | Select-String (":" + $Port + " ") | Select-String "LISTENING"
  return [bool]$hit
}

$env:PYTHONUNBUFFERED = "1"
$env:BD_CANVAS_DEV_ISOLATED = "1"
$env:BD_CANVAS_USER_DATA_DIR = (Join-Path $Root ".tmp-dev-user-data-enterprise")
$env:ENTERPRISE_PORT = "5313"
$env:ENTERPRISE_HOST = "127.0.0.1"
$env:ENTERPRISE_ALLOWED_ORIGINS = "http://127.0.0.1:6677"
$env:ENTERPRISE_IMAGE2_ASYNC_ENABLED = "1"
$env:FORCE_COLOR = "0"

if (-not (Test-Listening 5312)) {
  Start-Process -FilePath $py -ArgumentList @("-u", "server_v2.py", "--port", "5312", "--host", "127.0.0.1", "--dev") -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs "5312.out.log") -RedirectStandardError (Join-Path $logs "5312.err.log")
  Write-Host "5312 测试端后端：已启动"
} else { Write-Host "5312 测试端后端：已在跑" }

if (-not (Test-Listening 5313)) {
  Start-Process -FilePath $py -ArgumentList @("-u", "-m", "enterprise_server.app") -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs "5313.out.log") -RedirectStandardError (Join-Path $logs "5313.err.log")
  Write-Host "5313 后台管理：已启动"
} else { Write-Host "5313 后台管理：已在跑" }

if (-not (Test-Listening 6677)) {
  $vite = Join-Path $Root "node_modules\vite\bin\vite.js"
  Start-Process -FilePath "node" -ArgumentList @($vite, "--host", "127.0.0.1", "--port", "6677") -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs "6677.out.log") -RedirectStandardError (Join-Path $logs "6677.err.log")
  Write-Host "6677 网页入口：已启动（Vite 冷启动约 6s）"
} else { Write-Host "6677 网页入口：已在跑" }

Start-Sleep -Seconds 8
Write-Host ""
Write-Host "自检："
foreach ($u in @("http://127.0.0.1:5312/", "http://127.0.0.1:5313/admin/", "http://127.0.0.1:6677/")) {
  $code = curl.exe -s -o NUL -w "%{http_code}" --max-time 20 $u
  Write-Host ("  {0} => {1}" -f $u, $code)
}
