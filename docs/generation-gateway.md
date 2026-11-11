# 平台生成通道：出图 / 出视频也走平台 Key

这份文档说明 VisionQA 的出图 / 出视频通道（`/api/gateway/v1/*`）：它解决什么问题、
接口长什么样、怎么鉴权、怎么选 Key、失败了怎么排查，以及画布侧怎么接（**尚未执行**）。

适用代码：`server/gateway.mjs`（转发与任务登记）、`server/routes/gateway.mjs`（HTTP）、
`server/config.mjs` 的 `gateway` 段、后台「模型 Key → 生成通道」卡片。

## 一、解决什么问题

Key 池以前只服务文本与视觉（对话、评审）。出图 / 出视频这条路原来是断开的两截：

- 画布的出图 / 出视频节点用它自己的密钥表，跟平台 Key 池没有关系；
- 平台 Key 池里能声明「出图 / 出视频」能力，但没有任何调用路径。

通道补上中间那段：**调用方把生成请求发给 VisionQA，VisionQA 按平台 Key 池选一把上游 Key 转发**。
以后加一把出图 Key 只改后台，不动画布。

## 二、接口

协议按火山方舟（Ark）的公开形态实现，因为画布的出图 / 出视频节点用的就是这一套。

| 用途 | 方法与路径 | 关键请求字段 | 返回 |
| --- | --- | --- | --- |
| 出图 | `POST /api/gateway/v1/images/generations` | `model` `prompt` `size` 等原样转发 | 上游 `data[]`，另附 `urls[]` |
| 出视频 · 建任务 | `POST /api/gateway/v1/videos/generations` | `model` `content[]` `ratio` 等原样转发 | 上游 `id`（任务 id） |
| 出视频 · 轮询 | `GET /api/gateway/v1/videos/generations/<id>` | — | 上游任务状态，含 `content.video_url` |

出图是同步的：一次请求等到图。出视频是异步的：建任务拿 id，然后按 id 轮询。
**轮询必须回到建任务的那把 Key**，所以服务端记住「任务 id → Key」的对应关系。

## 三、鉴权

调用方是画布服务端，不是浏览器，所以不用用户会话，用平台服务令牌：

```http
POST /api/gateway/v1/images/generations
Authorization: Bearer <VQ_GATEWAY_TOKEN>
Content-Type: application/json
```

- 令牌存在服务端 `.env` 的 `VQ_GATEWAY_TOKEN`，用常量时间比较，长度不同直接拒。
- **没配令牌时通道整体回 503**，不会退化成匿名可用。
- 令牌与画布账号互通的共享密钥分开两把：一把泄露只轮换一把。
- 令牌明文不进浏览器、不进日志；后台只显示前后各四位（如 `5340••••4f5e`）。

## 四、怎么选 Key

与聊天链路同一套规则（`resolveKey`）：启用的 Key → 声明了本次能力（`image` / `video`）→
模型白名单匹配 → 跳过冷却中的 → 取优先级最小的一组 → 组内按权重随机。
池里没有可用 Key 时**不回落环境变量**（生成类调用没有历史凭证可退），直接回
`503 NO_IMAGE_KEY` / `503 NO_VIDEO_KEY`，并说清「去后台加一把声明了对应能力的 Key」。

每次转发都会写一条路由记录（能力 / 模型 / Key / 理由 / 耗时 / 成败），后台「最近路由」能查到。
轮询的中间态不单独记日志，只在任务到终态（成功 / 失败）时补一条，避免每 5 秒刷一行。

## 五、失败口径

| 情况 | 返回 |
| --- | --- |
| 没有令牌 / 令牌不对 | `401 GATEWAY_UNAUTHORIZED` |
| 通道未配置 | `503 GATEWAY_NOT_CONFIGURED` |
| 没有对应能力的 Key | `503 NO_IMAGE_KEY` / `503 NO_VIDEO_KEY` |
| 上游 4xx / 5xx | `502 UPSTREAM_REJECTED` + 人话说明 + `upstreamStatus` |
| 连不上上游 / 超时 | `502 UPSTREAM_UNREACHABLE` |
| 上游 200 但没有图片地址 / 任务 id | `502 UPSTREAM_EMPTY` |
| 轮询未知任务（服务重启） | `404 TASK_NOT_FOUND`，提示重新发起 |

上游失败会计入该 Key 的失败次数，连续 3 次冷却 60 秒 —— 和聊天链路共用同一份健康度。

## 六、后台能看到什么

「模型 Key」页最下面「生成通道」卡片：

- 通道开没开（令牌是否配置，只显示前后四位）；
- 出图 / 出视频 Key 各几把、可用的模型有哪些；
- 三个接口的路径与用途；
- 接入地址（一键复制，给画布侧填）；
- 正在跑的视频任务与它走的那把 Key。

## 七、画布侧怎么接（**尚未执行**）

画布现在的出图 / 出视频端点是写死的 Ark 地址，密钥来自它自己的 `enterprise_api_keys` 表。
要接到本通道，需要三步，**都还没做**：

1. 把 `enterprise_server/generation_seedream.py` 的三个端点常量
   （`SEEDREAM45_ENDPOINT` / `SEEDREAM50_PRO_ENDPOINT` / `SEEDREAM50_FLASH_ENDPOINT`）
   和 `generation_seedance.py` 的 `SEEDANCE_BASE_URL` 改成读环境变量；
2. 把环境变量指向 `https://visionqa.wavisionai.cn/api/gateway/v1`（图片走 `/images/generations`，
   视频走 `/videos/generations` 与轮询）；
3. 在画布的企业密钥表里加一条指向本通道的记录（值填平台服务令牌），把模型分配指过去。

顺序很重要：**先有出图 Key，再接画布**。现在池里没有任何出图 / 出视频 Key，
接过去只会让画布的生成按钮稳定报 503，反而看不出问题在哪。

## 八、验证情况

已验证（生产，2026-11-11）：

- 通道未带令牌 → `401 GATEWAY_UNAUTHORIZED`；
- 带上令牌但池里没有出图 Key → `503 NO_IMAGE_KEY`（出视频同理 `NO_VIDEO_KEY`）；
- 公网入口（`https://visionqa.wavisionai.cn/api/gateway/v1/...`）与内网行为一致，说明 nginx 转发与 TLS 都对；
- 后台「生成通道」读到真实状态：通道已开启、令牌前后四位、出图 / 出视频 Key 各 0 把。

尚不能验证：真实出图 / 出视频（需要一把方舟出图 Key，等业务给）。链路本身由
`node scripts/test-gateway.mjs` 用假上游跑通：出图转发、上游 500、空结果、视频建任务 + 轮询、
无 Key 报错、未配置令牌 503、日志不含 Key 明文。

## 九、还没做

- **计费**：通道不在积分链上扣费。画布自己有免费额度与计费，平台侧暂不重复收费。
- **按用户配额**：现在只认服务令牌，不认「谁在生成」；要按账号计量得让画布带上用户身份。
- **任务持久化**：视频任务与 Key 的对应关系在进程内存里，重启后旧任务查不到（画布会重新发起）。
- **多进程**：如果以后 Node 起多实例，任务登记要挪到共享存储。
- **非方舟供应商**：OpenAI 系 `/images/generations` 形态可用；百炼的异步出图协议不同，没接。
