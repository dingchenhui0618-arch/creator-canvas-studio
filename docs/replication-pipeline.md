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

## 已知限制

- 视觉模型分析只看画面，**听不到声音**：没有配音和字幕的视频，口播由模型给出「建议口播」，音效/BGM 一律标「不确定」。
- 抽帧上限 18 帧，长视频会按时间均匀取样，超长视频的细节会丢。
- 平台下载的视频有体积上限（默认 160 MB），且依赖平台链接可解析。
- 模板库是单机 JSON 存储，没有账号隔离与并发写保护。
