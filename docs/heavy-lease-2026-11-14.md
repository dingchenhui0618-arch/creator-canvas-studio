# 跨进程重活名额：两个实例共用一个数（v0.9.78）

日期：2026-11-14　生产版本：0.9.78　入口：`index-DoNQ3EI0.js`　release：待部署

## 一句话

生产机同时跑两个 Node 实例（对外 8799 + 内部版 8800），以前「全站重活上限 3 条」其实每个实例各 3 条；
这一轮把名额做成**共享目录里的租约文件**，两个实例数同一个数，进程被杀时名额按 pid 立刻归还。

## 问题是怎么确认的

不是猜的，是读生产 unit 读出来的：

```
# /etc/systemd/system/visionqa.service
ExecStart=/usr/local/bin/node --experimental-sqlite server/index.mjs
Environment=NODE_OPTIONS=--max-old-space-size=384

# /etc/systemd/system/visionqa-internal.service
ExecStart=/usr/local/bin/node --experimental-sqlite server/index.mjs
# /etc/visionqa-internal.env
API_PORT=8800
DATA_DIR=/var/lib/visionqa-internal
VQ_UI_MODE=internal
```

两个进程跑同一份代码、同一台 2 核 / 1866 MB 的机器：

| 这一层 | 以前（v0.9.77） | 实际后果 |
| --- | --- | --- |
| 全站重活上限 3 条 | 进程内 Map 计数 | 最多 **3 + 3 = 6** 条重活同时跑 |
| 评审 worker 池 | 每进程 3 个、每个 192 MB 堆 | 最坏 **6 × 192 MB** 堆同时活着 |
| 水位红线 | 读 `/proc/meminfo`，整机口径 | 只有它是对的 |

水位是整机一条线，名额却是每进程一份——这就是缺口。

## 为什么不选别的

| 方案 | 为什么不选 |
| --- | --- |
| 用 SQLite（auth.db）记名额 | 两个实例的 `DATA_DIR` 不一样，看不到同一张表；放共享目录又要再造一个库 |
| 起一个协调进程 / Redis | 为 2 核机器上一个「最多 3 条」的计数再加一个常驻服务，得不偿失 |
| 把上限从 3 改成 1.5 | 上限是整数条；改成 1 会让一台机器只接一条重活，等于白买一半机器 |
| 靠 systemd 只留一个实例 | 内部版是对外版的灰度/演示环境，产品上要留 |
| 共享目录里的租约文件（选了它） | 零依赖、跨进程原子（mkdir 锁）、崩溃可判（pid）、可观测（一个文件一条） |

## 做法

新增 `server/heavy-lease.mjs`：

- **一条租约 = 一个文件**：文件名 `<pid>-<时间戳36>-<序号36>.lease`，内容是 `{pid, kind, startedAt, owner, host}`。
  只在根目录放计数需要的东西，不放任务内容。
- **数一下 + 占一个放在 mkdir 锁里**：锁就是目录 `<shared>/.lock`，`mkdirSync` 天然原子；
  超过 2 秒的锁按「拿锁的进程死在中间」清掉，等待上限默认 400 ms。
- **名额满就在锁里拒**：`limit > 0 && 在跑数 >= limit` → `ok:false`，带上 `active / limit / byKind`，
  调用方在扣费之前回 503 `SERVER_BUSY`（和 v0.9.70 的文案、状态码一致）。
- **崩溃即归还**：读租约时先 `process.kill(pid, 0)`，pid 不在（ESRCH）就删文件；`EPERM` 算活着
  （两个实例一个是 `visionqa`、一个是 root）。
- **心跳防误清**：活着的租约每 15 秒 `utimes` 一次；30 分钟没动静的按泄漏清掉（默认 TTL）。
- **降级不硬扛**：共享目录写不了 / 拿不到锁 → 退回进程内计数（v0.9.77 的行为），
  状态里标 `source: 'process'`、`degraded: true`，并记一次 `dirFail/lockMiss`。
  目录失败后 60 秒才重试，不会每个请求都去撞它。
- **开关**：`VQ_HEAVY_LEASE=0` 整条关掉，回到进程内计数（不用回滚版本）。
  其余可调：`VQ_HEAVY_LEASE_DIR`（默认系统临时目录下 `visionqa-heavy-leases-v1`）、
  `VQ_HEAVY_LEASE_TTL_MS`、`VQ_HEAVY_LEASE_HEARTBEAT_MS`、`VQ_HEAVY_LEASE_LOCK_MS`。

### 接进闸门

`waterline.admit(kind)` 现在做三件事，顺序固定：

1. 内存水位（守卫开着时才看）：到红线 → 503 `MEMORY_PRESSURE`，不占名额；
2. **占名额**：重活在共享目录里创建租约；被拒 → 503 `SERVER_BUSY`（名额满）、不扣积分；
3. 返回 `{ ok, level, lease }`，`lease.release()` 必须由调用方在收尾时调。

三个扣费入口（`server/index.mjs` 的 `beginPaid`、`routes/review.mjs`、`routes/flows.mjs`）的
**每一条提前返回路径**都补了 `releaseAdmission()`，成功路径挂在 `release()` 里；
`release()` 是幂等的（`released` 标记 + `clearInterval`），重复调用无害。

匿名请求以前不经过 `enter()`，于是**不占全站名额、也不出现在在跑数里**；现在 admit 在用户判断之前，
匿名重活也计数——这是顺手修掉的一个小口径漏洞。

### 两个可观测口

1. `GET /api/admin/waterline`：`heavy` 多了 `scope`（`lease` = 整机共用 / `process` = 退回进程内）
   和 `lease`（enabled / dir / total / byKind / otherPids / ttlMs / heartbeatMs / stats{created,released,refused,pruned,lockMiss,dirFail,parseFail}）。
2. `GET /api/admin/waterline/admission?kind=review|flow_run|replicate`：**只读预检**。
   走的是和真实请求同一个 `admit()`，占到的名额立刻还回去——不扣积分、不调上游、不落记录。
   运维（和这一轮的验收）不用为了「现在能不能接一条」而发一次真实重活。

## 本机验收

```
npm test            693/693（+11）
oxlint              0 error / 7 warning（既有）
tsc -b              干净
npm run build       通过（入口未变：index-DoNQ3EI0.js）
```

新增 `test/heavy-lease.test.mjs` 9 条 + 路由级 1 条 + 预检 1 条 + 语法护栏 1 条：

- 名额就是租约：占满就拒、还回来立刻能进、`limit 0` 只记不拦；
- **另一个进程占的租约看得见**：真起一个子 Node 进程占 2 条，父进程按整机名额拒；
- **进程没了名额立刻回来**：杀掉子进程，下一次数名额按 pid 清掉（不用等 TTL）；
- 死 pid 的租约不算名额；陈旧（pid 在但一小时没心跳）租约按泄漏清掉；
- 心跳：TTL 300 ms、心跳 80 ms，占 900 ms 后仍被算作 1 条；
- 共享目录写不了：`source=memory`、`degraded=true`，重活不被全拒；
- 预检接口：名额被占 → `ok:false / SERVER_BUSY / active 1 / limit 1`；空着 → `ok:true` 且**名额归还为 0**；
  kind 只认三种重活（`search` → 400）；
- 路由级：子进程占满 → 真实画布运行路由 503 且不扣积分、不落运行记录；杀掉子进程 → 同一路由 200 并照常记账；
- 语法护栏：`server/` 与 `scripts/` 下每个模块都能被解析（见下面的「踩到的坑」）。

## 踩到的坑（如实记）

第一次部署（release `r89-lease`）带了**被截断的 `server/index.mjs`**：一次整文件写入把最后约 90 行吞掉了。
692 条测试全绿、CI 也绿——因为没有任何测试 import `server/index.mjs`（测试只 import 路由与模块）。
直到 `systemctl restart visionqa` 时 journal 才炸出 `SyntaxError: Unexpected end of input`，
对外服务中断约 **86 秒**（05:25:22 → 05:26:48），当场 `ops/rollback.sh` 回 0.9.77、线上恢复。

修好文件后补了一条语法护栏（`test/syntax.test.mjs`）：用一个子进程（`--experimental-vm-modules` 的
`vm.SourceTextModule`）把 `server/` 与 `scripts/` 下每个模块解析一遍，0.8 秒。
第一版是「每个文件起一次 `node --check`」，实测 46 秒——太慢，换成一次子进程后降到 1 秒内。
护栏本身也验过：喂一段截断代码，它报的就是 `Unexpected end of input`。

## 生产实测

部署：release `20261113-213240-r89-lease2`（第一次 `r89-lease` 带了被截断的 index.mjs，已回滚并重发，见「踩到的坑」）。

| 观测 | 结果 |
| --- | --- |
| 版本 | 对外 8799 与内部版 8800 都是 `0.9.78`；`/api/health` ok（模板 26）、三个 unit active、journal 6 分钟内无 error |
| 计数来源 | `/api/admin/waterline` → `heavy.scope = "lease"`、`lease.dir = "/tmp/visionqa-heavy-leases-v1"`、`ttlMs = 1800000`、`heartbeatMs = 15000`、空闲时 `lease.total = 0` |
| 第三进程占 3 条 | 在机器上以 root 起一个独立 node 进程占 3 条 `review` 租约（pid 1460752）；**跑在 visionqa 用户下的对外实例**读到 `active = 3`、`byKind.review = 3`、`full = true`、`otherPids = [1460752]` |
| 三种重活都被拦 | 预检 `admission?kind=review / flow_run / replicate` → 全部 `503 SERVER_BUSY`、`active 3 / limit 3`，耗时 1–3 ms |
| SIGKILL 后立刻归还 | `kill -9` 后租约文件仍在盘上；下一次扫描 `pruned = 3`，`active = 0`、`otherPids = []`，预检回到 `ok: true`（1 ms），没等 30 分钟 TTL |
| 其它 | `stats = {created:1, released:1, refused:3, pruned:3, lockMiss:0, dirFail:0, parseFail:0}`；余额 **9950 未变**（本轮零扣费调用） |

内部版 8800 有自己的账号库（`DATA_DIR=/var/lib/visionqa-internal`），没有为这次验收造测试账号；它跑同一份代码（版本一致）、用同一个默认目录，
计数来源相同。真正实测过的是「root 起的第三进程 ↔ visionqa 用户下的服务进程」这一对——恰好是权限更难的那个方向（目录必须 0777 才成立）。

## 边界

- **只在同一台机器上互认**：目录是本机 tmpfs/磁盘。多机部署需要真正的协调者（Redis / 专用服务），没做。
- 目录权限 0777：两个实例一个是 `visionqa`、一个是 root，必须互相能写能删；这台机器上只有这两个服务账号。
  租约内容不含用户数据（只有 pid / kind / 时间 / 主机名）。
- 名额是「按请求」的，不是「按 worker 槽位」的：一条复刻请求里可能有多个 HTTP 调用，仍只占一个名额。
- worker 池仍是每进程 3 个：跨进程名额把「同时在跑的评审」压到 3 条，所以最坏情况是 3 条评审分布在两个进程里，
  但仍可能落在同一个进程（3 个 worker 全忙），另一边空闲——名额对，槽位不复用。
- 租约目录被别的进程恶意写满 → 可以伪造占位（本机信任边界内不设防）。

## 回滚

```
VQ_HEAVY_LEASE=0        # 回到进程内计数（v0.9.77 行为），不需要回滚版本
```
