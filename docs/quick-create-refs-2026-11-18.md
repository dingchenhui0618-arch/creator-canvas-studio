# 快捷创作：参考图 / 参考视频 / 模型选择（2026-11-18，0.9.193）

## 一、这次补的是什么

用户给的参照是私有原型仓库 `dingchenhui0618-arch/chenyuzhiyun-`（晨羽智云，AI 工作流市集原型）里的
`src/QuickCreate.tsx`。那套「快捷创作」里有四件我们的界面一直没有的东西，这轮按原型的做法补齐：

| 原型里的东西 | 我们的实现 | 落在哪 |
| --- | --- | --- |
| 上传本地参考素材（图片 / 视频 / 音频），素材库里挑 | 参考图 / 参考视频上传 + 「我的素材」挑回；视频读出**几秒、多少像素、多大** | `server/media-assets.mjs`、`/api/media/assets` |
| 按生成方式决定能放几个素材（多模态 9 个 / 首帧 1 个 / 参考 1 个） | 方式：文生 / 参考图（图片）、文生视频 / 首帧 / 多模态参考（视频），上限按模型规格校验 | `server/media-models.mjs` |
| 模型下拉 + 切模型后参数跟着变 | 模型 / 方式 / 比例 / 时长 / 清晰度五个下拉，全部由 `GET /api/media/models` 下发 | `src/pages/AgentsPage.tsx` |
| 图片与视频各自的草稿（切来切去提示词不丢） | 两个面板都挂着、只隐藏非当前的：提示词、参数、素材、正在跑的任务都留在原处 | 同上 |

## 二、原型看清楚的三件事（也是我们没照抄的地方）

1. **原型的模型表是死的**（Seedream / Seedance / MiniMax 十来个，含我们自己没有的）。我们只列
   生产 Key 池里真声明了的模型：图片 `gpt-image-2`；视频 `seedance-2.0`、`seedance-2.0-fast`。
   没真调过的那一档在菜单里直接写「未真调」，不装作验过。
2. **原型是纯前端假数据**（`assets` 存的是 dataURL，`video://` 这种假地址）。我们这边素材要真的
   落到账号目录、真的进上游，所以多了上传、归属、配额、大小限制一整套。
3. **原型没有「参考素材怎么进上游」这件事**。这一步我们的依据是无限画布那套已经跑通的实现
   （`/opt/bdcanvas/enterprise_server/generation_seedance.py`，见下面第四节）。

## 三、服务端改了什么

### 参考素材（`server/media-assets.mjs`，新）

- 只认文件头：jpg / png / webp / gif、mp4 / mov / webm；改名的 html、svg 进不来。
- 图片 ≤ 8 MB、视频 ≤ 48 MB；每个账号 60 个 / 400 MB，超了顶掉最旧的。
- 元信息（宽、高、秒数）由浏览器读出来随上传带上，服务端只校验形状与范围，不猜。
- 归属：目录带账号 id，读的时候按归属校验；生成时只认自己账号的素材，别人的 id 一律当不存在。
- 接口：`POST /api/media/assets`（原始字节，不是 JSON —— 8 MB 的图 base64 之后就是 11 MB，
  超过 8 MB 的 JSON 请求体上限）、`GET /api/media/assets`、`GET /api/media/assets/:id/file`（Range）、
  `DELETE /api/media/assets/:id`。

### 模型与规格（`server/media-models.mjs`，新）

- 一张表定死「能选什么、每个模型收不收素材、比例/时长/清晰度有哪些、每次多少积分」。
- 默认模型取 `server/model-routes.mjs` 的统一路由（图片 gpt-image-2、视频 seedance-2.0），
  不在别处再写一份默认值。
- 比例的顺序就是界面默认值：图片 `1:1` 在前、视频 `9:16` 在前；清晰度 `720p` 在前 —— 与这轮之前的默认一致。

### 出图带参考图（`server/gateway.mjs`）

- 新的 `generateImageEdit()`：把参考图 + 提示词按 multipart 发到 OpenAI 兼容通道的 `/images/edits`。
  只对 openai 形态的 Key 有意义，其它协议直接回「参考图只能走 OpenAI 兼容的图片通道」，不含糊。
- 与同步出图共用一套 Key 选择、路由记录、配额记账；失败照旧全额退款。

### 出视频带参考素材（`server/gateway.mjs`）

按 SeeAPI 的规矩（依据见第四节）：先把每个素材传到 `/v1/assets/references/upload` 换 `asset://`，
再放进建任务正文的 `reference_image_urls` / `reference_video_urls`，并带上 `mode`。

- **同一把 Key 上传 + 建任务**：素材挂在那把 Key 的账号下，换一把 Key 上传、另一把建任务，上游很可能找不到。
- 建任务失败会换下一把 Key，但会**重新上传一遍素材**（否则新 Key 看不到旧素材）。

### 路由（`server/routes/media-gen.mjs`）

- `GET /api/media/models`：界面下拉的真源。
- `POST /api/generate` 的正文多了 `model` / `mode` / `assets[]`；校验全部在服务端（模型、方式、参数、素材个数与归属）。
- 任务元数据多了 `model` / `mode` / `assets`（只存形状与大小，不存文件内容），「最近生成」里能看到「参考 1」。

## 四、参考素材进上游的契约依据

来自无限画布（`/opt/bdcanvas/enterprise_server/generation_seedance.py`，线上真跑过的实现）：

| 环节 | 地址 / 字段 |
| --- | --- |
| 参考素材上传 | `POST {SeeAPI}/v1/assets/references/upload`，multipart：`file`（reference_<kind>_<n>.<ext>）+ `kind`（image / video / audio），回 `asset_uri`（`asset://…`） |
| 建任务正文 | `model`、`prompt`、`duration`、`aspect_ratio`、`resolution`、`count`、`mode`、`reference_image_urls[]`、`reference_video_urls[]` |
| mode 映射 | 纯文本 `text2video`；seedance-2.0 只带图 `image2video`；图/视频混着 `mixed2video` |
| 个数上限 | seedance-2.0 系：image_limit 9、video_limit 3、total 15 |

出图参考图那边没有现成实现可抄，走的是 OpenAI 官方那一套（`/v1/images/edits`，multipart：
`model`、`prompt`、`size`、`image`）。**这一条没有真调过**，见第五节。

## 五、验收

| 项 | 结果 |
| --- | --- |
| 测试 | **1390 / 1390**（media-gen 从 14 条加到 18 条） |
| 新增用例 | 模型清单形状与「未真调」标记；上传参考图 → 出图真的走 `/images/edits`（断言 multipart 里的 model / size / prompt / 文件名）；参考图 + 参考视频 → `reference_*_urls` 与 `mixed2video`；文生模式收素材 / 参考缺素材 / 别人的素材 / 错模型一律 400 且不扣费；素材只属于上传的人 |
| 本机端到端 | 临时实例 + 假上游：上传「参考猫.png」（640×480、81.3 KB）→ 自动切到「参考图」→ 生成 → **edits 收到 1 次请求** → 结果「图片 · 81.3 KB · 参考 1」；切到视频页签写「视频这边的提示词」再切回来，图片页的提示词与素材都还在 |
| 窄屏 | 390 宽：页面 `scrollWidth = innerWidth = 390`，输入框区 288/288，无横向滚动；参数一行一个，标签不再被挤成竖排 |
| 真实上游 | **0 次**：这轮没有真调 GeteAPI 的 /images/edits，也没有真调 SeeAPI 的参考素材上传 |

## 六、诚实边界

1. **参考图出图、参考素材生视频都还没真调过**：multipart 字段与 `asset://` 的写法来自官方文档与
   无限画布那份跑通的实现，但「GeteAPI 上的 gpt-image-2 收不收 /images/edits」「SeeAPI 的参考素材
   上传在 VisionQA 这把 Key 下能不能用」都没验证。失败一定全额退回，所以试一次最多损失时间；
   真调需要用户点头（见下）。
2. **图片只有 GPT Image 2 一个可选**：GeteAPI 的 gpt-image-2.5/2.6 单次成本高于当前 5 积分，摆进下拉
   等于让用户点了就亏，这轮不开。视频有两档（2.0 / 2.0 Fast），Fast 没真调过、菜单里标了。
3. **音频参考没做**：原型支持音频素材，SeeAPI 也有 reference_audio_urls，但我们的上传与播放链路没做，
   所以界面只收图片与视频。
4. **素材库只有「我上传的」**：还不能从「最近生成」里直接挑一条结果当参考（那是下一步）。

## 七、截图（本机临时实例 + 假上游，真实渲染）

- `docs/quick-create-refs-1440.png`：图片页签，参考素材托架（参考猫.png · 640×480 · 81.3 KB）、
  模型 / 方式 / 比例三个下拉、提示词。
- `docs/quick-create-result-1440.png`：生成完成后的结果区（图片 · 81.3 KB · 参考 1）。
- `docs/quick-create-video-1440.png`：视频页签，模型下拉展开（Seedance 2.0 / Seedance 2.0 Fast · 未真调），
  比例 9:16、时长 4s、清晰度 720p。
- `docs/quick-create-refs-390.png`：390 宽，参数一行一个。

## 八、下轮可以做的

- 用户点头后各真调一次：参考图出图（约 $0.05）、参考图生视频 4s 480p（约 ¥1.4）。
- 「最近生成」里挑一条结果直接当参考素材。
- 音频参考（需要播放器与时长读取）。
- 素材库的删除入口（服务端已有 `DELETE`，界面还没放按钮）。
