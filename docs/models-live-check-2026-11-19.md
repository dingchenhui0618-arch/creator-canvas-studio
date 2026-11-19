# 真实模型连通性体检（2026-11-19，生产机实测）

> 目的：上线前把「每个模型到底能不能真的出东西」跑一遍，而不是只信 Key 在池里。
> 全部调用都用**生产机上的真实 Key**发出，走的是用户点按钮时同一条服务端路径（含扣费与退款）。
> 费用：文本/视觉可以忽略，出图约 $0.05/张，出视频 4s/480p 约 ¥1.4/条；本轮共花约 ¥5。

## 结论（先说重点）

| # | 模型 / 能力 | 结果 | 实测数据 |
| --- | --- | --- | --- |
| 1 | 文本 `deepseek-flash` | ✅ 通 | 899 ms，回「可以」 |
| 2 | 视觉 `deepseek-flash` 读图 | ✅ 通 | 1154 ms，200；是真图（1024×1024 PNG） |
| 3 | 图片 `gpt-image-2` 文生图 | ⚠️ 时好时坏 | 成功 1 次：39.8 s、2,336,378 B（1024×1024 PNG）；随后连挂 3 次 HTTP 500 `do_request_failed` |
| 4 | 图片 `gpt-image-2` 参考图（`/images/edits`） | ⏳ 没真调过 | 这条链路仍是 `referenceVerified: false` |
| 5 | 视频 `seedance-2.0` 4s/480p | ❌ 拿不回成片 | 上游 275 s 出片成功（`job_rWj37ZQ0NeGWc07R`），我们下载失败：`ERR_TLS_CERT_ALTNAME_INVALID` |
| 6 | 视频 `seedance-2.0-fast` 4s/480p | ❌ 拿不回成片 | 上游 153 s 出片成功（`job_58qN4Dpznib1iQk5`，761,170 B），下载同样失败 |

## 一、视频：上游出片了，但结果地址今天拿不到

两条视频的问题完全一样，**不是我们发错参数**：

1. 上游回执里的地址是 `https://cdn.orangelight.com.cn/.../output/video.mp4`；
2. 这个域名的边缘证书是腾讯云 CDN 的 `*.cdn.myqcloud.com`，**不含 `cdn.orangelight.com.cn`**——
   Node 的 fetch 直接 `ERR_TLS_CERT_ALTNAME_INVALID`，一句「fetch failed」看不出是谁的问题；
3. 把域名校验单独跳过（证书链仍然校验）再请求，返回 **HTTP 418、0 字节**；
   换浏览器 UA、Referer、Origin、`Range`、带上 Bearer 都是 418；
4. 同一地址在**另一台机器（本机 Windows）**上也是 418 —— 不是生产机 IP 被墙。

所以今天 SeeAPI 交回来的成片地址**任何人都下不动**。11-18 那批视频是能下载的（2.9 MB mp4 落过盘），
说明这是上游今天的回归，不是我们一直坏着。

**我们能做与已做**：退款、说清楚是谁的问题、网络抖动时重试。真要恢复出片，得等上游修 CDN，
或者把视频通道换成另一家（需要你定：换哪家、愿不愿意为此真调一条付费视频）。

## 二、图片：上游两种失败，用户看到的都是一句「失败」

| 失败形态 | 上游原文 | 旧文案 | 新文案（本轮改） |
| --- | --- | --- | --- |
| 内容策略挡回 | `the image we created may violate our content policies` | 「上游拒绝了这次生成（HTTP 400 upstream_error）」——读起来像我们参数发错 | 「上游按内容策略挡回了这次生成（不是你操作的问题，换个说法再试；这次不计费）」 |
| 上游 5xx | `HTTP 500 do_request_failed` | 「上游暂不可用（HTTP 500 do_request_failed）」 | 「上游暂不可用，过几分钟再点一次（HTTP 500 do_request_failed）」 |

两种都会**全额退回积分**（「最近生成」里那一行会写「失败 · 已退 5 积分」），这轮没有改计费。

一个真实用户（抽屉减半 / `usr_iyvFVOPFaHla`）2026-11-19 12:47 那次失败就是**内容策略误判**：
提示词是「生成一只橘猫」，5 积分已退回，账号没问题。

## 三、本轮因此改的代码

1. `server/gateway.mjs`：内容策略单独识别（不再归成「拒绝」）、5xx 给「过几分钟再点一次」；
   导出 `friendlyUpstream` 以便单测。
2. `server/media-fetch.mjs`：取回上游文件时**网络类失败重试两次**（1.2 s / 2.4 s 退避），
   404、超大小、证书问题不重试；证书问题单独给出「上游 CDN 配置问题」的说法。
3. `server/routes/media-gen.mjs`：视频「上游出片但取回失败」不再原样显示 `fetch failed`，
   改成「上游已出片，但取回文件失败（试了 N 次）：这次已全额退回积分，稍后重新生成一次」。
4. 新增 `test/media-download-retry.test.mjs`（5 条）与 `test/gateway-openai.test.mjs` 的两条文案用例。

## 四、还没做、但建议做的

- **参考图出图（`/images/edits`）真调一次**（约 $0.05）：这条链路从上线到现在没验过，
  界面上「参考图」页签会走它。
- **视频通道兜底**：主通道挂掉时能不能自动换一家，或者至少让后台看到「今天视频下载全挂」的告警。
- **图片成功率**：GeteAPI 今天 1 成功 / 3 个 500 / 1 个内容策略，这个成功率上线会被用户投诉；
  建议加一条备用出图通道（方舟 Seedream 已在池里，但没有接到路由上）。

## 五、怎么复现这份体检

脚本不进仓库（含生产内部路径与会话步骤），做法记在这里：

1. 在生产机上用 `server/auth.mjs` 的 `createSession` 给管理员签一张临时会话，跑完 `destroySession`；
2. 文本/视觉直接打 `resolveKey({ capability })` 选出的那把 Key 的 `/chat/completions`；
3. 图片/视频走 `POST /api/media/generate` + 轮询 `GET /api/media/tasks/<id>`（和用户点按钮同一条路）；
4. 每次调用记：状态、耗时、字节数、错误原文、扣费与退款。
