# 桌面端安装包：构建、产物与实装验收（v0.9.1，2026-11-12）

## 结论

v0.9.0 起桌面端有两个可直接分发的文件：NSIS 安装包与免安装单文件。
两者都**未签名**，且**没有接自动更新**；除此之外，安装、卸载、重装后的数据保留都在本机实装走通过。

## 构建

```powershell
npm ci
npm run desktop:icon   # 由 Electron 渲染品牌 mark，输出 build/icon.ico（16/24/32/48/64/128/256 七档）
npm run desktop:dist   # electron-builder --win --x64
```

- 配置：`electron-builder.yml`。打包内容只有 `electron/**` 与 `package.json`，**不打包 `dist/`**：
  外壳加载的是生产站点，网页本体不随客户端走。
- 复用 npm 已下载的 Electron：`electronDist: node_modules/electron/dist`，打包时不再从 GitHub 拉一份。
- 图标：`scripts/make-icon.cjs` 用 Electron 把品牌 mark 渲染成 16–256 七档再封成 `build/icon.ico`；
  产物入库，日常重编不需要再跑。

## 产物（2026-11-12 本机构建）

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| `release-desktop/VisionQA-Setup-0.9.1.exe` | 103,057,739 B | `a86fbac1a498845ea7a5247ad7d3a14147c610bd6e4d9305937e5c4cf97b4771` |
| `release-desktop/VisionQA-Portable-0.9.1.exe` | 94,862,438 B | `e9658b68d165a4f8edaeb60eb15926c5e2b64a8983a285709c620eb95d62609b` |

v0.9.0 的两个产物已被 0.9.1 覆盖（同一天发布：0.9.0 是安装包本身，0.9.1 补长期记忆的后台提炼与语义召回）。

产物与 `release-desktop/` 都不入库（每份近 100 MB）。**哈希只对这一次构建有效**，重编后必然变化；
要校验就对本机这一份跑 `Get-FileHash -Algorithm SHA256`。

构建同时生成 `latest.yml` 与 `.exe.blockmap`：那是 electron-builder 给自动更新准备的元数据，
应用里没有接更新源，所以现在**不会**检查更新，也不该把它们当成已启用更新。

## 安装行为

- 默认「仅为我安装」（per-user，不弹 UAC）到 `%LOCALAPPDATA%\Programs\VisionQA`，向导里可改目录。
- 需要磁盘约 330.4 MB（Electron 运行时占大头）。
- 建开始菜单与桌面快捷方式各 1 个；卸载项写进 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`，
  卸载命令带 `/currentuser`。
- 用户数据在 `%APPDATA%\VisionQA Desktop`（v0.8.0 及以前是 `creator-canvas-studio`）：
  首次启动会把旧目录整个搬一次，会话、长期记忆、登录态都保留。
- 卸载默认保留用户数据（`deleteAppDataOnUninstall: false`），重装后会话与记忆还在。

## 本机实装验收（2026-11-12）

| 检查 | 结果 |
| --- | --- |
| 安装向导 | 三页截图：安装选项 / 选定安装位置（503×362）/ 完成 |
| 安装目录 | `%LOCALAPPDATA%\Programs\VisionQA\VisionQA.exe`，文件版本 0.9.1、产品名 VisionQA |
| 卸载项 | `VisionQA 0.9.1`，`Uninstall VisionQA.exe /currentuser` |
| 快捷方式 | 开始菜单 1 个、桌面 1 个 |
| 装好后启动 | 加载生产站点，状态栏「桌面端 0.9.1」，5 条会话与旧记忆都在（覆盖安装） |
| 静默卸载 `/S` | 安装目录、卸载项、两个快捷方式全部清掉；`%APPDATA%\VisionQA Desktop` 保留 |
| 静默重装 `/S` | 版本 0.9.1 回来了，卸载项与两个快捷方式各 1，5 条会话 / 记忆仍在，应用正常启动 |
| 免安装版 | 双击后自解压运行并加载生产站点，页面与安装版一致 |

截图：
`screenshot-desktop-setup-2026-11-12.png`、`screenshot-desktop-setup-finish-2026-11-12.png`、
`screenshot-desktop-installed-2026-11-12.png`。

## 已知边界

- **未签名**：`Get-AuthenticodeSignature` 返回 `NotSigned`。从网络下载后首次运行会被 SmartScreen 拦一次；
  本机构建产物没有下载标记，所以本机安装时没有弹窗——这不代表分发给别人时也不会弹。
- **没有自动更新**：换版本靠重新下载安装包覆盖安装；更新源与签名要等决策。
- 安装包只含外壳代码，网页与接口仍以生产站点为准；断网时打开会显示站点加载失败，本地工作区不可用。
- 本机 C 盘当时可用 2.9 GB，安装需要 330.4 MB；磁盘更紧的机器要先腾空间。
