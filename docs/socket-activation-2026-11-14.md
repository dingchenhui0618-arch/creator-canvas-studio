# 发版不再 502：把监听端口交给 systemd 握着（v0.9.71，2026-11-14）

## 一、结论先行

- **问题**：发版 = `systemctl restart` = 进程退出、端口关闭。这几百毫秒里 nginx 连不上后端，用户看到 **502**。上线清单 **B3「发布不中断」** 一直卡在这里，而它是每轮都在发生的事。
- **做法**：用 **systemd socket 激活**——`visionqa.socket` 单元替进程一直握着 `127.0.0.1:8799`，重启时只换进程、端口不断开：新连接进入监听队列排队，等新进程起来被 accept。Node 侧只多一条判断（`LISTEN_FDS / LISTEN_PID` → 用继承的 fd 3，否则照常 bind 端口），两种方式都保留。
- **实测（同一台生产机、同一个探针）**：
  | 方式 | 发版期间请求 | 失败 | 最长无响应 |
  | --- | --- | --- | --- |
  | 端口模式（旧行为） | 168 | **3 × 502**（18:55:10.745 / .885 / 11.045） | 570 ms |
  | socket 激活（新行为，**一次真实发版**） | 283 | **0** | 813 ms |
- 失败变成了「等一会儿」。第一次切换会有一次停服务（让出端口），之后每次发版都不再断端口；切换后自检失败会自己退回端口模式，不会留下一个起不来的站。

## 二、为什么以前会 502

nginx 的 `location /api/` 是 `proxy_pass http://127.0.0.1:8799`（没有 upstream 双实例）。`systemctl restart` 的顺序是「停旧进程 → 起新进程」：

1. 旧进程收到 SIGTERM，先把在跑的任务标中断、按账本退款，约 1.5 秒后退出；
2. 这 1.5 秒里端口已经不再接受新连接 → nginx `connect()` 被拒 → **502**；
3. 新进程起来、bind 端口、跑恢复逻辑，才开始接客。

以前报的「3–10 秒」是这么来的（本轮实测这台机器上重启窗口约 300 ms，探针 100 ms 一次刚好抓到 3 条 502）。

## 三、做了什么

| 环节 | 做法 | 在哪 |
| --- | --- | --- |
| 端口不再由进程握 | `visionqa.socket`：`ListenStream=127.0.0.1:8799`、`Backlog=128`（发版那一两秒的连接先排队） | `deploy/production/visionqa.socket` |
| 进程改用继承的套接字 | `inheritedListenFd()`：`LISTEN_FDS=1` 且 `LISTEN_PID` 是自己 → 用 fd 3；否则照常 `server.listen(port)` | `server/listen.mjs` + `server/index.mjs` |
| 切换 / 同步 | `install-socket.sh`：写 unit、`daemon-reload`、**停应用让出端口 → 起 socket 单元 → 起应用 → 健康自检**；自检失败自动 `disable --now` 退回端口模式。幂等，已开启时只同步 unit 内容 | `deploy/production/install-socket.sh` |
| 跟着发版走 | 每次 `deploy.sh` 先跑一次 `install-socket.sh`（失败只告警，不阻断发布） | `scripts/deploy.sh` |
| 新装机器 | `install.sh` 在起服务前写入并启用 socket 单元 | `deploy/production/install.sh` |
| 验收工具 | `deploy-hammer.mjs`：按间隔打只读接口，统计总请求 / 失败 / 最长无响应 | `scripts/deploy-hammer.mjs` |

**为什么不用双实例轮换**：两个 Node 进程共享同一个 `DATA_DIR`（JSON 存储 + SQLite），并发写会互踩，后台定时任务也会跑两份。socket 激活是「一个进程、一直有一个端口」——不需要第二个写者。

## 四、实测（生产，2026-11-14 02:55–02:56）

探针：`node scripts/deploy-hammer.mjs --url https://visionqa.wavisionai.cn/api/version --seconds N --interval 100`（非 200 与网络错误都算失败）。

| 场景 | 结果 |
| --- | --- |
| **端口模式**（`systemctl disable --now visionqa.socket` 后重启服务） | 168 次请求，**3 条 502**（18:55:10.745 / 18:55:10.885 / 18:55:11.045），最长无响应 **570 ms** |
| **socket 激活**（`install-socket.sh` 之后**真发一版**：`deploy.sh /tmp/vq-v0.9.71.tgz`） | 283 次请求，**0 条失败**，最长无响应 **813 ms**（请求排队等新进程，不是报错） |

同一时刻服务端日志能对上听法：

`~json
{"at":"2026-11-13T18:55:11.062Z","t":"listen","port":8799,"listen":"port",...}
{"at":"2026-11-13T18:55:41.232Z","t":"listen","port":8799,"listen":"systemd-socket",...}
`~

`ss -ltnp` 里端口同时挂在 systemd 与 Node 上，正是「systemd 握着、进程共享」的样子：

`~
LISTEN 127.0.0.1:8799 users:(("node",pid=1450072,fd=3),("systemd",pid=1,fd=102))
`~

## 五、边界

- **在途请求仍会中断**：已经发出去、还在算的请求（例如 40 秒的复刻）在旧进程退出时照样断，靠 v0.9.48 的中断恢复退款收尾。socket 激活解决的是「**新请求**进不来」。
- 进程仍然只能有一个：这不是热更新，只是「端口不断」。代码改动依旧要重启才生效。
- 端口从此由 socket 单元决定：改 `API_PORT` 要连着改 socket unit（`install-socket.sh` 会按 `API_PORT` 重写）。
- 第一次切换会多停一次服务（让出端口）；切换脚本自带健康自检与退回。
- 多机 / 多 worker 部署时，socket 单元要跟着装，否则退回端口模式（行为正确，只是发版还会断一下）。

## 六、怎么复验

`~bash
# 生产：确认听法（port / systemd-socket）
ssh root@... "journalctl -u visionqa --no-pager -o cat | grep -e listen | tail -3"
ssh root@... "systemctl is-active visionqa.socket; ss -ltnp | grep 8799"

# 生产：发版不中断（跑 45 秒探针，另开一个终端发版）
node scripts/deploy-hammer.mjs --url https://visionqa.wavisionai.cn/api/version --seconds 45

# 想复现「旧行为」：先关 socket 单元再重启，探针会抓到 502
ssh root@... "systemctl disable --now visionqa.socket && systemctl restart visionqa"

# 恢复 socket 激活
ssh root@... "bash /opt/visionqa/deploy/production/install-socket.sh"
`~

## 七、回滚

`~bash
# 只退回端口模式（保留新版代码）
ssh root@... "systemctl disable --now visionqa.socket && systemctl restart visionqa"
# 回上一版发版
ssh root@... "bash /opt/visionqa/ops/rollback.sh --to <release 序号>"
`~

## 八、文件

| 文件 | 改动 |
| --- | --- |
| `server/listen.mjs` | 新增：`inheritedListenFd()`（LISTEN_FDS / LISTEN_PID 判断，`VQ_LISTEN_FD` 供本地 e2e）、`listenMode()` 日志口径 |
| `server/index.mjs` | 有继承 fd 就 `listen({fd})`，否则照常 listen 端口；`listen` 事件里记下这次是怎么听的 |
| `deploy/production/visionqa.socket` | 新增：socket 单元模板（端口占位符 `__API_PORT__`） |
| `deploy/production/install-socket.sh` | 新增：幂等切换 / 同步，自检失败自动退回 |
| `deploy/production/install.sh` | 新装机器在起服务前启用 socket 单元 |
| `scripts/deploy.sh` | 发版前跑一次 install-socket.sh（失败只告警） |
| `scripts/deploy-hammer.mjs` | 新增：发版期可用性探针（B3 验收工具） |
| `test/listen.test.mjs` | 新增 5 条：systemd 约定 / PID 不匹配 / 无 socket / 显式 fd / 日志口径 |

## 九、下一步

- **B2 剩下**：worker 隔离与跨进程并发（要第二台机器或独立 worker）。
- **B4**：CI 里加 `npm audit --omit=dev` 与密钥扫描（gitleaks）。
- 用户侧输入没变：定价 + 商户号、配额数字、10 次真实复刻成本、SMTP、告警 webhook、ICP / 主体 / 客服邮箱、异地备份目的地、一次真实出图授权。
