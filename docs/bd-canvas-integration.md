# BD Canvas 接入方案（Source-Available，不入仓）

日期：2026-11-03 · 状态：**等源码包到位后执行**（本机还没找到压缩包）

## 一、结论先行

BD Canvas 是 **Source-Available（源码可见）** 项目，许可证是 BD Canvas Source-Available License v1.0，不是开源协议。条款里明确禁止「把源码或修改版以任何形式发给别人」和「把软件本身当产品或订阅服务卖」，并且不能删改版权声明、不能声称是自己写的。

所以本仓库的处理方式是：

1. **不 vendor、不提交、不打包** BD Canvas 的任何源码或构建产物（本仓库是公开仓库，提交就等于分发）。
2. BD Canvas 单独部署在本机 `D:\Projects\bd-canvas`（仓库外），跑它自己的三个端口。
3. 工作台只做「探活 + 跳转/内嵌」：`GET /api/bdc/status` 探测 6677 / 5313 / 5312，画布页检测到它在跑就显示接入条，可一键内嵌或新窗口打开。
4. 文档里只写部署方式与接口事实，不复制它的代码。

## 二、部署步骤（来自对方给的部署手册，按其原文执行）

环境：Windows 10/11、Python ≥3.10、Node ≥18。

| 步骤 | 命令 / 动作 | 验收 |
| --- | --- | --- |
| 1 装依赖 | 项目根 `npm install` | `node_modules\vite` 存在 |
| 2 环境变量 | `Copy-Item .env.example .env`，用 `python -c "import secrets;print(secrets.token_urlsafe(48))"` 生成两个值填 `ENTERPRISE_JWT_SECRET` / `ENTERPRISE_KEY_SECRET` | 两个 SECRET 不以 CHANGE_ME 开头 |
| 3 保持不变 | `ENTERPRISE_PUBLIC_DEPLOYMENT=0`、`ENTERPRISE_PUBLIC_REGISTRATION_ENABLED=0`、`ENTERPRISE_HOST=127.0.0.1` | 文件里就是这三行原值 |
| 4 启动 | 双击 `启动.vbs` | `netstat -ano | findstr ":5313 :6677"` 有监听；失败看 `launcher-crash.log` |
| 5 登录后台 | `http://127.0.0.1:5313/admin/`，首次账号 `bdadmin` / `bdadmin123456` | 能进后台 |
| 6 改密码 | 用户管理里立即改掉 | 新密码可登录 |
| 7 配模型 Key | 后台「模型 Key」→ 新建，字段名必须准确：`name` / `provider` / `key` | 列表里出现这条 Key |
| 8 分配能力 | 用户管理 → 选用户 → 配置 assignment，`model` 与 `feature` 必须匹配 | 不返回 400 |
| 9 出图验收 | 普通用户在网页入口 `http://127.0.0.1:6677` 生成一张图 | 真的出一张图 |

后台登录接口是 `/enterprise/api/admin/auth/login`，返回 **JWT token 不是 cookie**，后续请求带 `Authorization: Bearer <token>`。

端口职责：5312 后端 / 5313 后台管理 / 6677 网页入口。

## 三、工作台这边的接入（已实现，等 BD Canvas 起来即生效）

- `GET /api/bdc/status` → `{ web, admin, api, deployed }`，逐个探测三个地址，超时 1.2s，失败不抛错。
- 画布页：`deployed=true` 时顶部出现接入条「BD CANVAS · 本机已部署」，可「在这里打开」（iframe 内嵌 6677）或「新窗口」；内置流程编排保留作为备选，两套数据互不影响。
- 环境变量可覆盖默认地址：`BDC_WEB_URL` / `BDC_ADMIN_URL` / `BDC_API_URL`。

## 四、和现有功能的边界

| 能力 | 归谁 |
| --- | --- |
| 图像生成、额度、用户与 Key 管理 | BD Canvas（5313 后台） |
| 爆款检索、拆帧、模板库、智能体对话 | 本工作台（8787/5191） |
| 视觉评审（visual-baseline） | 本工作台 `/api/review`；BD Canvas 内部评审不接管 |
| 流程画布 | 优先 BD Canvas；内置编排是备选，便于没有 BD Canvas 时演示 |

## 五、还没做 / 需要确认

- **源码包位置**：本机 `D:\Projects` 与下载目录都没有找到 BD Canvas 压缩包，需要落到 `D:\Projects\bd-canvas` 后再执行第二节。
- 管理员初始密码必须在第一次登录后改掉；我不会把密码写进任何文件。
- 模型 Key 由你提供，我不代持凭据。
