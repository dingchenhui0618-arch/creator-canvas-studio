# 运行水位：这台机器还能接多少活（2026-11-14，v0.9.69）

## 一、为什么做这条

上线清单里的 **B2「容量与 worker 隔离」** 一直写着「复刻并发 2 会顶到内存」，但后台没有任何内存读数，也没有任何闸门。

真实水位（2026-11-14 02:05 实测）：**2 核 / 1.86 GB 内存，swap 6 GB 已用 1.6 GB，Node 堆上限 384 MB**
（systemd 里 `NODE_OPTIONS=--max-old-space-size=384`，V8 实际 heap_size_limit 408 MB）。

- 一次复刻要同时跑 **ffmpeg 子进程**与**逐帧视觉**（18 帧送模型）；
- 一次画布运行要下载并分析多张图；
- 两条重活并行就够把内存顶穿。

被顶穿时进程会被内核或 V8 直接杀掉：**所有人的会话一起断**，正在跑的任务只能靠 v0.9.48 的中断恢复退款。
钱退回来了，但用户看到的是「任务被系统中断」——对一个要收钱的产品，这不是可接受的状态。

这一轮只做三件很朴素的事：**量清楚、偏紧时降并发、到红线在扣费前拒**。

## 二、做了什么

| 环节 | 做法 | 在哪 |
| --- | --- | --- |
| 量 | 系统可用内存取 `/proc/meminfo` 的 **MemAvailable**（含可回收缓存；MemFree 会把页缓存算成不可用，误判成快满了）；进程堆取 **V8 的 heap_size_limit**（跟着 `--max-old-space-size` 走），不拿 RSS 倒推 | `server/waterline.mjs` |
| 判 | 纯函数：可用内存 < 128 MB **或** 堆 ≥ 92% → `critical`；< 320 MB **或** ≥ 80% → `tight`；否则 `ok`。读数是注入的，测试不依赖跑测试那台机器的内存 | `assessWaterline()` |
| 降 | `tight` 时把**重活**的并发上限压到 1（原来不限也收紧到 1）：宁可慢一点，不要两条一起死 | `capacityFor()` |
| 拒 | `critical` 时在**扣费之前**返回 503 `MEMORY_PRESSURE`，提示写清「这条任务没有开始（没有扣积分）」，带 `retryAfterSec: 60` | 复刻 / 评审 / 画布运行三处入口 |
| 可见 | 后台「系统 → 运行水位」：可用内存、进程 RSS 与堆、CPU 负载、三档判定胶囊、三条重活的当前并发上限、判定口径与检查时间 | `GET /api/admin/waterline` + `WaterlineCard` |
| 告警 | 真到红线拒绝时进站内告警（kind `memory`），5 分钟内只记一条，不按每次拒绝刷屏 | `recordAlert` |

关键取舍：**只拦「已经到红线」，不预估单次任务要占多少内存。**
同样是 18 帧，清晰度、模型批次差几倍，估错就会拦错；与其猜，不如「撑不住时这一单不接」。

### 代码清单

| 文件 | 改动 |
| --- | --- |
| `server/waterline.mjs`（新） | 读数、纯判定、并发折算、`admit()`、后台视图、告警节流 |
| `server/config.mjs` | 新增 `waterline` 段；新增 `numEnv()`——环境变量写空值时回到默认值，不再被 `Number('') = 0` 把闸门悄悄关掉 |
| `server/index.mjs` | `beginPaid()` 在扣费前 `admit(kind)`，并发上限走 `capacityFor()`（覆盖检索与复刻两个入口） |
| `server/routes/review.mjs` | 评审入口同一套闸门与并发折算 |
| `server/routes/flows.mjs` | 画布运行入口同一套闸门与并发折算 |
| `server/routes/admin.mjs` | `GET /api/admin/waterline`（**只读**，没有写入分支） |
| `src/api/waterline.ts`（新） | 类型 + 请求 |
| `src/pages/admin/WaterlineCard.tsx`（新） | 「运行水位」卡：数字、胶囊、标签化的堆进度条、三条并发上限、判定口径 |
| `src/styles/console.css` | `.admin-waterline-bar-row` 等（沿用全站 6px 细条与 token，不另造视觉） |
| `test/waterline.test.mjs`（新，8 条） | 判定三档 / 阈值写 0 / 并发折算 / 真实读数 / 到红线拒且不扣费 / 告警节流 / 整条关掉 / 后台 403-200-无写入 |

## 三、阈值口径

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `VQ_WATER_CRITICAL_MB` | 128 | 可用内存低于它 → `critical`，重活不接 |
| `VQ_WATER_TIGHT_MB` | 320 | 低于它 → `tight`，重活并发降到 1 |
| `VQ_WATER_CRITICAL_HEAP` | 92 | 进程堆占比 ≥ 它 → `critical` |
| `VQ_WATER_TIGHT_HEAP` | 80 | ≥ 它 → `tight` |
| `VQ_WATER_GUARD` | 开 | 写 `0` 只量不拦（后台照样看到数字与等级） |

- **任意一个阈值写 0 = 关掉那一条判定**，不会误伤另一条。
- 阈值只读：后台没有「调高红线」的按钮，要改就改部署环境变量。
- 只拦三种重活（复刻 / 评审 / 画布运行）。检索只是转发一个 HTTP，对话只有几十 KB 上下文，不跟着拦。

## 四、生产实测（v0.9.69b，2026-11-14 02:24）

| 检查 | 结果 |
| --- | --- |
| 版本 / 入口 | `/api/version` **0.9.69**，入口 `index-BZI9mBvu.js`（第一次发版是 `index-DexqNzoA.js`，补了堆进度条标签后重发） |
| 健康 | `/api/health` ok（templates 26），部署后 0 个 5xx |
| 判定 | `level: ok`、`reasons: []`、`guard: true` |
| 系统内存 | 可用 **859 MB** / 共 1866 MB；交换已用 **1624 / 6144 MB**（历史压力留下的，不是现在在换页） |
| 进程 | RSS **86–89 MB**，Node 堆 **12 / 408 MB（3%）**（上限就是 systemd 里的 384 MB） |
| CPU | 2 核 · load1 **0.74** · load5 0.24 |
| 并发上限 | 一键复刻 **2 条**、视觉评审 **1 条**、画布运行 **1 条**（与配置一致，说明没触发降级） |
| 拒绝参数 | `retryAfterSec: 60` |
| 390 宽 | `docScrollWidth 390`、`viewport 390`、横向溢出元素 **0** |
| 控制台 | 后台 0 异常（桌面与 390 各一次） |

**生产从未被闸门拦下过**（水位 ok）。所以「到红线会怎样」不能拿生产造低内存来演——
用同一份代码起一次性实例，**把阈值抬到天上**，走的是同一段判定与拒绝代码：

| 场景 | 做法 | 实测 |
| --- | --- | --- |
| 到红线 | `VQ_WATER_CRITICAL_MB=999999` | 后台显示 `critical`、三条重活 **0 条**（"按水位从 2 条收紧"）；`POST /api/replicate` → **503 `MEMORY_PRESSURE`**，提示「服务器内存紧张，这条任务没有开始（没有扣积分）：系统可用内存 1132 MB，低于红线 999999 MB。等一分钟再试。」；余额 **100 → 100**；job 表 **0 → 0**（不落任务）；同一时刻检索照常 **200**（示例数据） |
| 偏紧 | `VQ_WATER_TIGHT_MB=999999`、红线关掉 | 后台 `tight`、复刻 **1 条**；`POST /api/replicate` **200**（接单，只是同账号并行压到 1） |
| 默认 | 不强制 | `level ok`；本机 16194 MB / 可用 1218 MB、堆上限 4288 MB（开发机与生产的差别在读数里如实体现） |

## 五、边界（这一轮没解决什么）

- **不是 worker 隔离**：重活仍跑在同一个 Node 进程里，靠水位降级而不是分机器。真正的隔离要单开 worker 或加一台机器。
- **跨账号的全局并发上限还没有**：「偏紧降到 1」是**每个账号**的并发上限，不是全局并发。两个账号同时各跑 2 条复刻，这里管不住。
- **阈值是经验值，没有压测支撑**：B2 验收里的「10 个并发不出 OOM」没做（需要真实压测与真实任务）。
- **只拦三个付费重活**：检索、对话、上传、分享页不在闸门里。
- **告警 5 分钟一条**：连续拒绝只累加次数，不会每条都推。
- **拒绝时已经是草稿**：复刻的草稿在扣费前落库（v0.9.48 的设计），被拒时按「未扣费」直接撤掉，不留空任务。

## 六、怎么复验

```bash
# 1. 生产读数（只读，不需要任何凭据即可看版本与健康）
curl -s https://visionqa.wavisionai.cn/api/version
curl -s -b "vq_session=<管理员 cookie>" https://visionqa.wavisionai.cn/api/admin/waterline
# 2. 本地复现三种水位（一次性实例，跑完即删）
node .tmp-qa/r80-e2e.mjs
# 3. 单测
node --experimental-sqlite --test test/waterline.test.mjs
```

## 七、回滚

- 代码回滚：`ops/rollback.sh --to <上一个快照>`（v0.9.68 的入口 `index-DgjMcNs0.js`）。
- 只关闸门不发版：服务器 `.env` 里加 `VQ_WATER_GUARD=0` 后重启服务——后台照样显示读数与等级，但不拦任何任务。

## 八、这轮的文件

- 新增：`server/waterline.mjs`、`src/api/waterline.ts`、`src/pages/admin/WaterlineCard.tsx`、`test/waterline.test.mjs`、`docs/runtime-waterline-2026-11-14.md`
- 修改：`server/config.mjs`、`server/index.mjs`、`server/routes/review.mjs`、`server/routes/flows.mjs`、`server/routes/admin.mjs`、`src/pages/admin/SystemSection.tsx`、`src/styles/console.css`、`package.json`（0.9.69）、`README.md`、`docs/launch-readiness-2026-11-12.md`
- 截图：`screenshot-waterline-2026-11-14.png`（生产正常态）、`screenshot-waterline-mobile-2026-11-14.png`（生产 390）、`screenshot-waterline-critical-local-2026-11-14.png`（本地强制红线）

## 九、下一步

按上线清单，B 类还剩 B3（发布不中断）、B4（CI 安全扫描）、B9（Node 版本锁）。B2 的「worker 隔离 / 全局并发」要等真实压测与机器，不属于这一轮的口径。
