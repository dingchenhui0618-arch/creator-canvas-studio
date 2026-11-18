# 快捷创作：一页面的对话（r213 契约）

目标：把「快捷创作」从短轮伪智能体改成长上下文对话，能力对齐 DeepSeek 官方「全家桶应用 API」
（deepseek-flash，服务端工具 + 文件解析），不再出现「智能体」字样的自我描述。

## 上游事实（2026-11-18 读官方文档）

- Base URL：`https://api.deepseek.com/v1`（生产 `.env` 的 VISION_BASE_URL 已指向它，Key 同一把）。
- 模型 `deepseek-flash`：1M 上下文 / 最大 384K 输出 / 支持图像理解、Tool Calls、JSON Output。
- Chat Completions 扩展（同一请求体里开启，服务端完成搜索与抓取）：
  - `tools: [{"type":"deepseek_web_search"},{"type":"deepseek_read_url"}]`
  - `thinking: {"type":"enabled"}`（思考模式；开搜索时服务端决定温度等）
  - `safety_check: {"level":"high"}`（对外服务必须开；命中返回 stop_reason=refusal）
  - `title: {"enabled":true}`（返回会话标题，在 message_delta 的 delta.title）
  - 流式：SSE，内容块 thinking / server_tool_use / web_search_tool_result / web_fetch_tool_result / text(+citations)
- 文件：`POST /files` multipart（purpose 必须在 file 之前）→ file_id；对话里用 content block
  `{"type":"file","file_id":"..."}`。purpose：text_recognition / rich_layout_recognition / user_data（txt/md/csv/代码/表格/电子书，免解析不计费）。
- OCR 独立接口：`POST /v1/tools/ocr`（multipart: purpose + file），按页返回 text。
- 计费：服务端搜索自 2026-11-18 12:00 起不再单独计费，只算 token；OCR/文件解析 1.5 元/千页。
- 搜索不单独计费的前提是「联网工具」触发；独立 Search/Fetch API 仍 5 元/千次（本功能不用）。

## 后端（server/deepseek-chat.mjs + server/routes/chat.mjs，已注册到 index.mjs）

会话落盘：`DATA_DIR/chat/<userId>/<conversationId>.json`（0600，原子写）。每条会话：
`{ id, title, createdAt, updatedAt, messages: [{ role, at, text, files?, citations?, thinking? }], summary? }`

接口（全部需登录，只认自己的会话）：
- `GET /api/chat/conversations` → `{ ok, items:[{id,title,updatedAt,messageCount}] }`，按 updatedAt 倒序，最多 50。
- `GET /api/chat/conversations/:id` → `{ ok, conversation:{id,title,messages} }`；别人的/不存在 404。
- `PATCH /api/chat/conversations/:id` `{title}`；`DELETE` 删除。
- `POST /api/chat/files` multipart（字段 file）→ `{ ok, fileId, name, kind:'image'|'document'|'text', pages? }`；单文件 ≤ 20MB。
- `POST /api/chat/turns` → SSE（`text/event-stream`），body：
  `{ conversationId?, text, tools:{search:boolean, readUrl:boolean}, thinking:boolean, fileIds?:string[] }`
  事件（每条 `data: {json}\n\n`）：
  - `{"type":"start","conversationId":"..."}`
  - `{"type":"thinking","text":"..."}`
  - `{"type":"search","queries":["..."],"results":[{title,url,siteName,snippet}]}`
  - `{"type":"fetch","url":"...","ok":true}`
  - `{"type":"text","text":"..."}`
  - `{"type":"refusal","message":"..."}`（stop_reason=refusal）
  - `{"type":"done","title":"...","usage":{"input":n,"output":n}}`
  - `{"type":"error","code":"...","message":"用户能看懂的中文"}`
- 上下文：服务端把整段会话（含历史块）按 token 预算（约 12 万字符上限）从旧到新保留最近若干轮，
  超出时把更早的对话压成一段 `summary`（用同一模型一次调用生成，失败就截断，不阻断回复）。
  绝不再由前端传 history。

## 扣费（保持现有口径，不许白送）

- 每一轮回复前先按现有 `server/credits.mjs` 的对话价（config.credits.prices.chat 或现 agents 路由同价）扣一次；
  失败或 refusal 全额退回；金额与文案沿用现有「对话」条目。禁止新增免费通道。

## 前端（src/pages/AgentsPage.tsx 的「对话」页签）

- 去掉「智能体」自我描述：标题/占位/空状态改成「对话」；自建的「智能体」改叫「对话预设」。
- 左侧会话列表（新建/切换/重命名/删除），中间消息流（Markdown 渲染、思考过程可折叠、搜索卡片可点开、
  引用角标），底部输入框（工具开关：联网搜索 / 读链接 / 深度思考；文件上传 chip）。
- 首次进入恢复最近一条会话；刷新不丢上下文。
- 390 宽不横向溢出；样式只用现有 token 与 `.agx-*` 前缀。
- 任何位置不出现上游品牌名（SeeAPI/GeteAPI/CGCM/DeepSeek/方舟/红狐），统一叫「平台对话模型」。

## 验收

- 新增 `test/chat-*.test.mjs`：会话隔离（A 读不到 B）、SSE 事件顺序、文件 purpose 映射、
  token 预算截断、refusal 退款、标题回写。用本地假上游（fetch 注入），不消耗真实额度。
- `npx vitest run test/chat-*.test.mjs` 全绿；不跑 tsc/build（Lead 统一跑）。
