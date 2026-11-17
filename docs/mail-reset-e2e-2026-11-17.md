# 找回密码整条链路已经在隔离环境里真跑通了（2026-11-17）

结论先行：**邮件通道的代码是通的，只差你的真实 SMTP 凭据**。这轮用一台临时实例 + 一个本地假 SMTP 收信口，把「后台配通道 → 发测试信 → 登录页忘记密码 → 从邮件里拿到一次性链接 → 换新口令 → 用新口令登录」整条链路真跑了一遍，12 步全绿；**生产一个字节没动**，也**没有向外部发出任何真实邮件**。

## 一、为什么先做这件事

SMTP 账号还在你手上，代码侧却一直悬着一个问题：拿到凭据填进去，到底能不能用？等凭据到了才发现协议/编码/链接有问题，代价比现在大。所以这轮把「凭据到位后会发生什么」提前演一遍——用假 SMTP 顶替服务商，其余环节全用真实代码。

## 二、怎么搭的

| 角色 | 位置 | 说明 |
| --- | --- | --- |
| 临时实例 | `127.0.0.1:8802` | 同一份 `/opt/visionqa/server/index.mjs`，`DATA_DIR=/tmp/vq-mail-e2e/data`，独立数据库与 mail.json |
| 假 SMTP | `127.0.0.1:2525` | 最小 SMTP 服务端：220 问候、EHLO、AUTH PLAIN / LOGIN、MAIL / RCPT / DATA / QUIT，每封信落成 `.eml` |
| 生产 | `127.0.0.1:8799` | **完全没参与**；测完检查 `/var/lib/visionqa/mail.json` 仍不存在，`visionqa` 仍 active |

配置走的是后台真实接口（`PUT /api/admin/mail/channel`），不是直接写文件——所以连「保存-校验-掩码」这一层也一起验了。

## 三、跑出来的证据

| 步骤 | 结果 |
| --- | --- |
| `GET /api/auth/config`（配之前） | `passwordReset: false` —— 登录页「忘记密码」不可用 |
| 管理员登录（用户名/口令） | 200，拿到会话 |
| `GET /api/admin/mail` | `configured: false` |
| `PUT /api/admin/mail/channel` | 200，`configured: true`、host/port 正确、口令只回掩码 |
| `POST /api/admin/mail/test` | **200 + 29ms / 65ms** —— 真和 SMTP 走完一轮对话才回话，不是只存配置 |
| `POST /api/auth/password/forgot` | 200，回统一话术（不暴露邮箱是否存在） |
| 假收件箱 | **2 封**：测试信 1621 B、重置信 3337 B |
| 重置信主题 | 「重置 VisionQA 口令（30 分钟内有效）」 |
| 邮件里的链接 | 取到一次性 token（正文是 multipart + base64，**解码后**才看得到） |
| `GET /api/auth/password/reset?token=…` | `valid: true`，`expiresAt 2026-11-17T05:12:58Z` |
| `POST /api/auth/password/reset` | 200，`signedOut: 1`（把旧会话踢掉） |
| 用旧口令登录 | **401** |
| 用新口令登录 | **200** |
| 同一枚 token 再用一次 | **400**「这枚链接已经改过口令了，请用新口令登录」 |
| `GET /api/auth/config`（配之后） | `passwordReset: true` |
| 临时实例日志 | `mail-sent` 1 次、`mail-link` 1 次、`mail-failed` **0 次** |

## 四、可复跑

脚本已经收进仓库 `scripts/mail-e2e/`（说明见该目录 README）。在服务器上：

```bash
MAIL_E2E_DIR=/tmp/vq-mail-e2e VQ_APP_ROOT=/opt/visionqa bash scripts/mail-e2e/run.sh
```

退出码 0 = 全链路通过。这套脚本在写完之后**从零又跑过一遍**（新的 `MAIL_E2E_DIR`），结果一致，说明它不是「只在我手上能跑」。

## 五、边界

- 假 SMTP 只能证明**客户端协议与产品逻辑**是对的（连得上、认证握手、正确拼信、链接可用、token 一次性、改完踢旧会话）。真实服务商在 STARTTLS、认证方式、反垃圾、退信策略上仍可能不同，**凭据到位后还要真发一封给真邮箱**才算完。
- 这轮一封真实外部邮件都没发；所有信件只落在 `/tmp` 的假收件箱里，测完随临时目录一起清理。
- 临时实例的测试账号是脚本自己造的测试地址，与生产账号无关。
- 生产 `mail.json` 至今不存在——也就是说**生产的「忘记密码」现在仍然发不出信**，这一步只能等你给 SMTP 账号。
