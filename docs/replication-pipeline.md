# 检索 → 一键复刻 → 模板库

这条链路的目标：**别人已经验证过的内容，能变成我可以直接套用的脚本与分镜模板。**

```
爆款雷达（检索）
   ↓ 选一条内容
一键复刻（弹窗）
   ↓ POST /api/replicate
解析视频地址 → 读取视频信息 → FFmpeg 抽帧 → 逐帧分析 → 写入模板库
   ↓ 轮询 /api/jobs/:id
模板库（检索 / 查看 / 复用）
```

## 当前状态

| 环节 | 状态 | 说明 |
| --- | --- | --- |
| 检索真实抖音/小红书数据 | **待接入** | 需要 `REDFOX_API_KEY`。未配置时返回示例数据，界面有黄条提示，不伪装真实数据 |
| 视频地址解析（平台链接 → mp4） | **待接入验证** | 代码已按红狐接口写好，但没有 Key 时无法验证真实链接；无 Key 时可用 mp4 直链跑通全流程 |
| FFmpeg 拆帧 | **已跑通** | ffprobe 时长/分辨率/帧率 + 场景切镜检测 + 均匀补帧，默认 4–18 帧 |
| 逐帧视觉分析 | **已跑通** | 一次调用把全部帧喂给视觉模型，输出严格 JSON；上游过载自动降级模型并重试 |
| 模板入库与检索 | **已跑通** | `data/templates.json` + `data/frames/<id>/`，按内容类型与关键词检索 |
| 用模板生成新内容 | **未做（按计划后置）** | 模板字段已按生成需求预留，等检索与复刻验收后再接内置智能体 |

验证用的素材是公开测试视频（Blender Foundation 的 Big Buck Bunny 片段、MDN 的 CC0 flower.mp4），界面中显示的标题、作者、互动数据都来自测试输入，不是真实平台数据。

## 复刻流水线

| 步骤 | 实现 | 失败时的行为 |
| --- | --- | --- |
| 解析视频地址 | `server/media.mjs`：直链直接下载；平台链接走红狐视频解析拿 `downloadUrl` | 回落到下一个来源；都没有则报「没有可用的视频链接」 |
| 读取视频信息 | `probeVideo`（ffprobe -show_format -show_streams） | 时长读不到直接失败，避免拿坏文件继续跑 |
| 检测切镜 | `detectSceneCuts`（ffmpeg `select=gt(scene,0.3),showinfo`） | 无硬切时退化为均匀抽帧 |
| 抽帧 | `planTimestamps` + `extractFrames`（`scale=480:-2 -q:v 3`） | 按帧序号继续，缺帧不阻塞 |
| 逐帧分析 | `server/vision.mjs`：system prompt 要求严格 JSON，含脚本结构 / 分镜 / 分析 | 非 JSON 追加修复指令重试；模型 5xx 重试后切换降级链 |
| 入库 | `server/templates.mjs`：帧图移动到 `data/frames/<id>/`，写入模板 JSON | 写盘失败时报错，不产生半成品模板 |

任务状态保存在内存（`server/jobs.mjs`），保留最近 40 个；服务重启后进度丢失，已入库的模板不受影响。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | `{ok, redfox, vision, visionModel, templates}`，前端据此显示「示例数据模式 / 红狐已连接」 |
| GET | `/api/search?platform=all\|douyin\|xiaohongshu&q=&start=&end=&page=` | `{mode:'live'\|'mock', items[], total, note}` |
| POST | `/api/replicate` | body `{item, url}`，返回 `{jobId}`；`url` 为空时用 `item.url` |
| GET | `/api/jobs/:id` | `{status:'running'\|'done'\|'error', step, progress, logs[], error, templateId}` |
| GET | `/api/templates?q=&type=` | `{items[], total, byType}` |
| GET | `/api/templates/:id` | 单个模板完整内容 |
| POST | `/api/templates/:id/reuse` | 复用计数 +1 |
| DELETE | `/api/templates/:id` | 删模板并清理帧图目录 |
| GET | `/api/cover?url=` | 封面图代理（避免平台图床的 referer / CORS 限制） |
| GET | `/media/frames/:id/:file` | 模板帧图 |

## 模板字段

```json
{
  "id": "tpl_5c6fea32",
  "title": "森林树洞藏着什么",
  "contentType": "剧情演绎",
  "tags": ["童话森林", "3D动画", "悬念开场"],
  "platform": "douyin",
  "platformLabel": "抖音",
  "sourceUrl": "https://…原视频链接…",
  "sourceId": "测试素材 id",
  "author": "Blender Foundation",
  "publishedAt": "2026-11-01 10:00",
  "stats": { "likes": 0, "comments": 0, "shares": 0, "collects": 0 },
  "durationSec": 10,
  "hook": "阳光再暖，这个树洞里也全是黑的——你敢往里看吗？",
  "hookType": "悬念",
  "structure": [
    {
      "beat": "环境铺垫",
      "startSec": 0,
      "endSec": 2,
      "voiceover": "森林最深处，有一棵谁都不敢靠近的老树。",
      "onScreen": "森林最深处",
      "purpose": "用低机位和暖光先把童话场景立住"
    }
  ],
  "storyboard": [
    {
      "shotNo": 1,
      "startSec": 0,
      "endSec": 2,
      "frameIndex": 1,
      "frameUrl": "/media/frames/tpl_5c6fea32/frame-01.jpg",
      "visual": "低机位看向阳光草地：粗大老树从覆满苔藓的土丘长出",
      "camera": "接近地面的低机位中景，轻微前推",
      "caption": "森林最深处",
      "audio": "不确定",
      "purpose": "建立童话森林空间，用暖光和绿意先给安全感"
    }
  ],
  "analysis": {
    "pacing": "中",
    "viralPoints": ["先给美景再收焦点到黑洞"],
    "reusableRules": ["奇幻/自然开场只用一个长镜头：先给美景，再把焦点收到一个异常点"],
    "targetAudience": "喜欢奇幻、自然氛围短片的用户"
  },
  "frames": [{ "index": 1, "t": 0, "url": "/media/frames/tpl_5c6fea32/frame-01.jpg" }],
  "cover": "/media/frames/tpl_5c6fea32/frame-01.jpg",
  "video": { "width": 640, "height": 360, "fps": 30, "duration": 10.0 },
  "origin": "ai",
  "reuseCount": 0,
  "createdAt": "2026-11-03T02:19:23.233Z"
}
```

字段是「按后续生成需求预留」的：`structure` 对应生成脚本，`storyboard` 对应生成分镜，`analysis.reusableRules` 对应生成时的约束条件，`sourceUrl` 保证可追溯。

## 接入红狐数据要做什么

1. 服务端起进程时配 `REDFOX_API_KEY=…`（不要写进前端、不要提交仓库）。
2. 抖音检索走 `POST /story/api/dy/data/searchWork`（header `REDFOX_API_KEY`），小红书走 `POST /story/api/xhs/search/search`（header `X-API-KEY`），返回字段在 `server/redfox.mjs` 里做了别名兼容。
3. 拿到 Key 后先跑一次「搜索关键词 → 看 `/api/search` 是否 `mode:'live'`」，再点一条内容试平台链接解析；小红书视频解析端点是按命名规律推断的（`/parseWork/videoDownload/xiaohongshu`），需要实测确认，失败时用直链兜底。
4. 界面上「示例数据模式」徽标会变成「红狐接口已连接」，黄条消失。

## 红狐实测结论（2026-11-03）

用真实 Key 打了三类请求，结论分「代码侧」和「账号侧」两部分：

**账号侧（不是代码能绕过的）**

| 现象 | 返回 | 说明 |
| --- | --- | --- |
| 认证 | 首次调用返回 `3210 积分不足` | Key 本身有效，但账号余额 0；充值商品为「100 元 = 1000 积分」，后台 `https://redfox.hk/dashboard/recharge` |
| 限流 | 并发 40 个不同关键词后出现 `接口调用过于频繁，当前限制为 10 次/秒 / 20 次/秒` | 抖音 10 次/秒、小红书 20 次/秒 |
| 封禁 | 继续压测后变为 `3105 API Key已禁用` | Key 被红狐侧禁用，需要到后台确认状态或更换 Key；**代码无法自行恢复** |

**代码侧（已修复的）**

| 问题 | 修复 |
| --- | --- |
| 触限时接口抛 500 | 统一识别「过于频繁」为可重试错误，重试仍失败则返回 `429` + 明确文案，前端显示红色提示条而不是 500 |
| 直接把上游打爆 | 客户端限流（抖音 4 次/秒、小红书 8 次/秒，各留余量）+ 每平台最多 2 个并发请求 |
| 重复请求浪费额度 | 同参数请求做 5 分钟缓存 + 单飞去重（并发相同的查询只打一次上游） |
| Key 被禁用后还在重试 | 识别 `3105` 立即短路 5 分钟，不再打上游；界面提示「Key 已被禁用」并给后台链接 |
| 积分不足被当成普通错误 | `3210` 单独映射，界面显示「账号积分不足 + 当前是示例数据」，不伪装真实数据 |

验证方式不依赖真实 Key：`npm run test:redfox` 会起一个本地假红狐服务（`scripts/mock-redfox.mjs`），断言限流不超速、缓存只打一次、限流错误会重试、禁用/积分错误不重试且短路，7 项全部通过。

## 压力测试结果

脚本：`node scripts/stress.mjs --test=search|reuse|replicate|edge [--n=N]`（只打本地 API）。

| 场景 | 规模 | 结果 |
| --- | --- | --- |
| 检索接口 | 40 并发（6 个关键词，缓存去重后 12 次上游） | 40/40 返回 200，p50 3.7s、p95 3.8s（耗时主要在上游配额校验往返） |
| 检索接口（不同关键词） | 40 并发 → 80 次上游调用 | 修复前 19/40 报 500；限流 + 缓存落地后不再出现 500，多余请求进队列 |
| 复刻流水线 | 5 条并发（360p/720p、5s/10s 混合） | 5/5 成功，墙钟 163 秒；抽帧 4–12 帧不等，模板全部入库 |
| 模板库完整性 | 压测后校验 7 条模板 | 结构/分镜/帧文件齐全，无重复 id，JSON 可解析 |
| 模板复用并发 | 同一条模板 25 并发 | 计数 0 → 25，无丢失更新 |
| 边界用例 | 无参数、无效 URL、404、非视频、不存在的任务/模板 | 全部给出明确错误（任务 error 或 404），无 500 崩溃 |
| 客户端单测 | 7 项 | 7/7 通过 |

复刻流水线在压测中表现稳定，主要瓶颈是视觉模型（单条 60–180 秒，上游过载时会走降级链），不是 ffmpeg 或存储。

## 已知限制

- 视觉模型分析只看画面，**听不到声音**：没有配音和字幕的视频，口播由模型给出「建议口播」，音效/BGM 一律标「不确定」。
- 抽帧上限 18 帧，长视频会按时间均匀取样，超长视频的细节会丢。
- 平台下载的视频有体积上限（默认 160 MB），且依赖平台链接可解析。
- 模板库是单机 JSON 存储，没有账号隔离与并发写保护。
