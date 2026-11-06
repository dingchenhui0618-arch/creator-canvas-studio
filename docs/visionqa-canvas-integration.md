# VisionQA Canvas 部署与接入记录（上游 BD Canvas 源码，不入仓）

日期：2026-11-04 · 状态：**已在本机部署并接入画布页**；生成链路还差模型 Key

## 一、结论先行

1. VisionQA Canvas 已解压到 `D:\Projects\bd-canvas`（仓库外），三个端口都在跑：5312 后端 / 5313 后台 / 6677 网页入口，实测都返回 200。
2. 工作台画布页已改成 **VisionQA Canvas 本体**：进「画布」直接是 VisionQA Canvas，本仓库那套节点编排退成「回到内置编排」的备选。
3. `bdadmin` 初始密码已按手册要求改掉（新密码不入任何文件、不入仓库）。
4. **还差一步**：后台「Key 管理」里没有任何渠道 Key，所以出图 / 出视频还没通。需要你给一个上游 Key（可选渠道：CGCM、火山方舟、火山语音、百炼）。

## 二、实测事实

| 检查 | 结果 |
| --- | --- |
| `GET http://127.0.0.1:5312/` | 200 |
| `GET http://127.0.0.1:5313/admin/` | 200 |
| `GET http://127.0.0.1:6677/` | 200（Vite 5.4.21，冷启动约 6s） |
| `GET http://127.0.0.1:8787/api/bdc/status` | `{"web":{"up":true,"status":200},"admin":{"up":true,"status":200},"api":{"up":true,"status":200},"deployed":true}` |
| `POST /enterprise/api/admin/auth/login` | 200，返回 JWT（不是 cookie） |
| 后台用户列表 | 2 个：内置保底超管（不可改）+ `bdadmin` |
| `npm install` | 239 个包，约 2 分钟 |
| 后台仪表盘 | 「管理服务正常」，2 个用户，今日调用 0 |

![VisionQA Canvas 后台管理](screenshot-bdc-admin.png)

## 三、执行时踩到的三个坑（复现必看）

### 1. 本机 PATH 里没有 Python

`启动.vbs` 按顺序找第一个存在的 `pythonw.exe`，**候选 0 就是项目内的 `python\pythonw.exe`**。本机没有系统 Python，所以直接把 Python 3.12 复制到 `D:\Projects\bd-canvas\python\`，三个候选路径里第 0 个就命中了。

注意别用 `python -m venv`：venv 的可执行文件在 `python\Scripts\` 下，而 VBS 只认 `python\pythonw.exe`，找不到就弹「Python not found」。

### 2. `requirements-backend.txt` 不全，缺两个包

按手册只装 `requirements-backend.txt` 时：

- `5313` 直接起不来：`enterprise_server/recharge.py` → `wechat_pay.py` 里 `from cryptography import x509`，**没有 cryptography**。
- `启动.vbs` 双击无反应：`launcher.py` 用 pystray 做托盘，**没有 pystray**，pythonw 静默退出，连 `launcher-crash.log` 都不写。

补装：

```powershell
.\python\python.exe -m pip install cryptography pystray
```

### 3. 项目根的 `.env` 没有任何代码读取

手册让你把两个 SECRET 填进项目根 `.env`，但 `enterprise_server/config.py` 只读 **`enterprise_server/.env.wechat-pay`**，全仓库没有别处加载根 `.env`（Flask 启动时还会提示 `There are .env files present. Install python-dotenv`，说明它也没被读）。

不处理的话两个 SECRET 会回落成源码里的 `change-me-*`。本次做法：根 `.env` 保留给人看，把同样是随机生成的 48 字符两个值**同步写进 `enterprise_server/.env.wechat-pay`**，这样不管从启动器还是直接起进程，读到的都是真随机值。

## 四、许可证边界（没变）

BD Canvas 是 Source-Available License v1.0：可自用、可改、可商用，但**禁止以任何形式再分发源码或修改版（免费也不行），禁止 SaaS 转售**。所以本仓库：

- 不 vendor、不提交、不打包 BD Canvas 的任何源码或产物；
- 只探活 + 内嵌，不复制代码；
- 文档只写部署方式与接口事实。

## 五、工作台这边的改动

- `GET /api/bdc/status` 探活超时：网页入口给 **5s**（Vite 开发服务器冷启动就要几秒，原来 1.2s 会把已部署误判成未部署），后台与后端仍 1.2s。
- 画布页：`deployed=true` 时**默认直接进 VisionQA Canvas**（全宽 iframe），页头换成 42px 紧凑状态条「画布 / VISIONQA CANVAS + 连接状态 + 当前地址 / 新窗口 / 回到内置编排」；未部署时仍是原来那套节点编排。
- 环境变量可覆盖默认地址：`BDC_WEB_URL` / `BDC_ADMIN_URL` / `BDC_API_URL`。

![画布由 VisionQA Canvas 接管](screenshot-canvas-bdc.png)

## 六、重启方式

三个进程都是本次部署拉起的，重启机器要再起。手工起步：

```powershell
cd D:\Projects\bd-canvas
$env:PYTHONUNBUFFERED=1; $env:BD_CANVAS_DEV_ISOLATED=1
$env:BD_CANVAS_USER_DATA_DIR="$PWD\.tmp-dev-user-data-enterprise"
.\.\python\python.exe -u server_v2.py --port 5312 --host 127.0.0.1 --dev
$env:ENTERPRISE_PORT="5313"; $env:ENTERPRISE_HOST="127.0.0.1"
$env:ENTERPRISE_ALLOWED_ORIGINS="http://127.0.0.1:6677"
.\.\python\python.exe -u -m enterprise_server.app
node .\node_modules\vite\bin\vite.js --host 127.0.0.1 --port 6677
```

也可以双击 `启动.vbs` 开图形启动器，但它的面板**需要手动点「全部启动」**（不会自动起服务）；上面三条已经在跑时再点会撞端口。

## 七、还没做 / 需要你决定

1. **模型 Key**：后台「Key 管理 → 新建 Key」三字段 `name` / `provider` / `key`，provider 下拉是 CGCM（全部视频/图像模型）、火山方舟、火山语音、百炼。给一个 Key 我就能配完并跑出图验收。
2. **能力分配（assignment）**：`provider + model + feature` 三者必须匹配（generate / chat / tts / voice-clone / reverse-prompt），配错返回 400。
3. **常驻**：要不要把 VisionQA Canvas 三个端口也加进看门狗（现有 `DSH Services` 只托管 dsh-web 与 image-shim），掉线自动拉起。
4. **公网暴露**：现在三个端口都只监听 `127.0.0.1`，符合手册要求。要对外就得上反向代理 + IP 限制，别直接映射 5313。
