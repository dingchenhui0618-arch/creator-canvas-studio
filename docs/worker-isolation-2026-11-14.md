# 评审重活隔离：池子、上限、以及「值不值得」的实测（v0.9.77）

日期：2026-11-14　生产版本：0.9.77　入口：`index-DoNQ3EI0.js`　release：`20261113-210054-r88-pool`

## 上一轮留下的问题

B2 还剩一项：**重活与 HTTP 服务共用一个进程和一个堆**。压测里 10 个并发大图评审曾把 384 MB 的堆打爆、
进程 FATAL OOM、所有人的会话一起断（`docs/load-test-2026-11-14.md`）。v0.9.74 的缩图把「堆随输入字节涨」
这条**基本**消掉了，但结构上仍然是「一个评审就能弄死整站」。

## 做法：有上限的 worker 池，不是「一单一个 worker」

先试了最直接的方案——每个评审开一个 worker 线程、跑完就收。压测当场否掉：

| 10 并发 × 8 MB · 闸门关 | 进程树峰值 | 主进程堆 | 健康探针 p95 |
| --- | --- | --- | --- |
| 同进程执行（原样） | 449 MB | 27 MB（7%） | 159 ms |
| 一单一个 worker | **700 MB** | 13 MB | **986 ms** |
| **池（3 个 worker 复用）** | **361 MB** | 17 MB（4%） | **19 ms** |

一单一个 worker 在 2 核机器上同时开 10 个 isolate：每个都要重新加载整套模块、都有自己的堆，
多花的 250 MB 和 800 ms 全在这里。所以改成**固定 3 个 worker 反复用**（`VQ_REVIEW_WORKERS`，默认 3，
与全站重活上限 `VQ_GLOBAL_HEAVY` 的默认值一致），超出的请求排队，内存与延迟才有天花板。

池的另外两条硬约束：

- worker 撞到 `VQ_REVIEW_WORKER_MB`（默认 192 MB）→ 只杀它自己，池补一个新的，请求拿到 503
  `REVIEW_WORKER_OOM`（积分照退）；
- 超过 `VQ_REVIEW_WORKER_TIMEOUT_MS`（默认 240 s）→ terminate，请求拿到 504 `REVIEW_TIMEOUT`。
- 评审的每一步（缩图、模型、判断层）都在 worker 里跑；写库只有用量台账的 SQLite INSERT，
  且 `auth.db` 打开时加了 `busy_timeout = 3000`，两条线程同时写不会立刻 SQLITE_BUSY。

## 生产机实测（2 核 / 1866 MB / 堆 384 MB，假上游 4 s，零扣费）

| 条件 | 模式 | 请求 | 进程树峰值 | 主进程堆 | 健康探针 p95 | 进 worker |
| --- | --- | --- | --- | --- | --- | --- |
| 生产默认（闸门开） | 同进程 | 3 进 / 7 拒 `SERVER_BUSY` | 193 MB | 19 MB（5%） | 15 ms | — |
| 生产默认（闸门开） | **池** | 3 进 / 7 拒 | 315 MB | 14 MB（3%） | 52 ms | 3 单（3 成功） |
| 闸门关（极限） | 同进程 | 10 / 10 | 449 MB | 27 MB（7%） | 159 ms | — |
| 闸门关（极限） | 一单一个 worker | 10 / 10 | 700 MB | 13 MB | 986 ms | — |
| 闸门关（极限） | **池** | 10 / 10 | **361 MB** | 17 MB（4%） | **19 ms** | 10 单（10 成功） |

所有臂都在生产机上用 `systemd-run --scope -p MemoryMax=1300M` 单独跑：端口 8798、数据目录在 `/tmp`，
不碰 8799 上的线上进程，不调真实模型（假上游固定 JSON），**本轮零扣费调用**。

## 代价与决定（不藏）

- 池不是免费的：生产默认条件下进程树 **193 → 315 MB**、健康探针 p95 **15 → 52 ms**。
  52 ms 仍然远低于「主线程被打到不可用」的 5 s 判定线，换来的是「单个评审 OOM 不再弄死整站」。
- 所以**默认开**，但要清楚备用开关：`VQ_REVIEW_ISOLATE=0` 退回同进程（上面两条「同进程」行就是它的基线），
  不用回滚版本。
- 池大小默认 3 是跟着全站重活上限定的：**调大 `VQ_GLOBAL_HEAVY` 时要一起调 `VQ_REVIEW_WORKERS`**，
  否则多出来的并发只会在池里排队。
- 隔离挡的是「堆被单个请求吃掉」，挡不了「整机内存不足」：worker 与主线程同进程、同 cgroup，
  ffmpeg 子进程的内存仍算这台机器的总账（实测子进程峰值 78–126 MB）。

## 怎么确认它真的在跑

- `GET /api/review/health` 多了 `isolate` 字段：`{ enabled, heapMb, workers, timeoutMs, runs, ok, failed, lastFailure, pool: { size, alive, idle, queued } }`。
  生产实测：`enabled: true, heapMb: 192, workers: 3, pool: { size: 3, alive: 0, idle: 0, queued: 0 }, runs: 0`
  —— 部署后还没人评审，所以是 0（没有为了让数字好看去发起一次真实评审）。
- 路由级测试里断言「这一单确实进了 worker」：`isolate.runs === 1`；同一文件里另有一条
  `VQ_REVIEW_ISOLATE=0` 的用例，证明开关真的能退回同进程且扣费口径不变。
- 单测 8 条：worker 撞 64 MB 上限、超时 504、worker 内部错误保留 code/status、池并发上限（5 单最多 2 个同时跑）、
  worker 撞死后池补新的、开关与上限的边界值、计数形状。

## 验收

- `npm test` **682/682**（+9：隔离池 8 条 + 路由「退回同进程」1 条）。
- oxlint 0 error / 7 warning（既有）、`tsc -b` 干净、`npm run build` 通过；密钥扫描见提交说明。
- 生产：`/api/version` 0.9.77、入口 `index-DoNQ3EI0.js`、`/api/health` ok（模板 26）、三个 unit active、余额未变。

## 回滚

`VQ_REVIEW_ISOLATE=0` + `systemctl restart visionqa`：评审回到主进程，行为与 v0.9.76 完全一致。
没有数据迁移，没有新表。
