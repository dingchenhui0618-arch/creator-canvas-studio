# 快捷创作：一页 DeepSeek 对话（r214 / v0.9.195–0.9.198，2026-11-18）

用户原话：「快捷创作我们现在属于是伪智能体，本质上只是上下文对话，那就不要写智能体什么的了……
做成一个页面的 deepseek，上下文的理解增强，不要就这么短轮的对话。」

## 已做

| 项 | 落点 |
| --- | --- |
| 默认进入「平台对话」 | 快捷创作 → 对话页签顶部「平台对话 / 对话预设」，默认平台对话；作品页「让 AI 起草」进来时自动切到「对话预设」（那条路要用结构化草稿的三个出口） |
| 长上下文 | 服务端存会话，发送时带最近 30 条、总字数封顶 6 万字；不是只带上一句 |
| 联网搜索 | 开关打开时带上官方服务端工具 `{"type":"deepseek_web_search"}` |
| 读链接 | `{"type":"deepseek_read_url"}` |
| 思考模式 | `thinking: {"type":"enabled"}` |
| 会话管理 | 新建 / 列表 / 打开 / 删除；最多 30 条会话、每条 200 条消息；存在服务端，换设备回来还在 |
| 扣费 | 每次对话 1 积分（`VQ_CREDIT_CHAT`），先扣后调；失败或空回复全额退回并明说「积分已退回」 |
| 接口 | `GET/POST /api/chat/conversations`、`GET/DELETE /api/chat/conversations/:id`、`POST /api/chat/conversations/:id/messages`；未登录 401，别人的会话 404 |

## 为什么单独一条链路

原来的「对话」是对话预设的短轮问答：每次带预设、输出类型、结构化草稿。数据形状、扣费口径、上下文长度都和「一页对话」不一样。硬塞进一个组件会让两边都难改，所以新增 `server/chat.mjs` + `server/chat-store.mjs` + `routes/chat.mjs`，前端新增 `src/components/QuickChat.tsx`；「对话预设」保留为第二个页签，草稿出口（存模板 / 送工作流 / 写进作品）不受影响。

## 验证

- `test/chat-store.test.mjs`：新建、列表、消息、上下文取舍、越权读、30 条上限。
- `test/chat-send.test.mjs`：本地假上游，验证 tools / thinking 真的发到上游、第二句带上一轮上下文、失败退款且余额回到原值、别人的会话读不到、空消息 400。4/4 通过，**0 次真实上游调用**。
- 生产：`/api/chat/conversations` 未登录 401、登录 200；页面截图 `docs/quickchat-1440.png`、`docs/quickchat-390.png`（390 宽无横向溢出）。

## 没做（别假装有了）

- 流式输出：现在是完整回复一次显示。
- 文件解析 / OCR / 图片理解进对话：要动上传与多模态消息，契约在 `docs/quick-create-deepseek-2026-11-18.md`。
- 语音（TTS/ASR）、标题自动生成、safety_check 级别：都还没接。
- 真实 DeepSeek 调用：按约定，助手不自行发起。用户第一次在页面上发消息时才是第一次真调。
