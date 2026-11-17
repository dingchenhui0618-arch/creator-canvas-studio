# 邮件链路自检（找回密码）

用本地假 SMTP 把「后台配通道 → 发测试信 → 忘记密码 → 从邮件取链接 → 换新口令 → 用新口令登录」整条链路真跑一遍。
**不碰生产数据**：临时实例用独立的 `DATA_DIR` 和端口，测完就停；生产 `/var/lib/visionqa/mail.json` 不会被创建。

## 什么时候用

- 手上还没有真实 SMTP 凭据，先确认「拿到凭据后能不能用」；
- 换了发信服务商，发信失败但不知道是网络、认证还是编码问题；
- 上线前想留一份「这条链路真的能发信」的证据。

## 怎么跑（在服务器上，`/opt/visionqa` 那台）

```bash
MAIL_E2E_DIR=/tmp/vq-mail-e2e VQ_APP_ROOT=/opt/visionqa bash scripts/mail-e2e/run.sh
```

默认参数：临时实例 `127.0.0.1:8802`、假 SMTP `127.0.0.1:2525`、收件箱 `$MAIL_E2E_DIR/inbox`。
测试账号是脚本自己造的测试地址（不是真人邮箱），口令也是临时口令。

退出码 0 表示整条链路通过；输出里每一步都能对上一行证据：

| 步骤 | 通过的样子 |
| --- | --- |
| `admin/mail/channel PUT` | 200，`configured: true` |
| `admin/mail/test` | 200 且带 `ms`（说明真的和 SMTP 走完了一轮对话，不是只存配置） |
| `password/forgot` | 200（接口不区分邮箱存不存在） |
| `inbox messages` | 2 封：测试信 + 重置信 |
| `reset peek` | `valid: true` + 过期时间 |
| `reset consume` | 200，`signedOut: 1` |
| `login with OLD pass` | 401 |
| `login with NEW pass` | 200 |
| `reset reuse` | 400「这枚链接已经改过口令了」 |

## 换真实 SMTP 之前要做什么

1. 在后台「设置 → 邮件通道」里填真实服务器、账号、口令、发件地址，点「发送测试邮件」——这一步就是本脚本第 5 步做的事，失败时它会原样回 SMTP 阶段的错误（连不上 / 认证被拒 / 发信被拒）。
2. 用任何一个真邮箱走一次登录页的「忘记密码」，确认信能进收件箱（不是只进了垃圾箱）。

## 文件

- `run.sh`：总入口，建临时目录、起 sink、起实例、跑断言、收尾。
- `sink.mjs`：最小假 SMTP（220 问候、EHLO、AUTH PLAIN/LOGIN、MAIL/RCPT/DATA/QUIT），每封信落成 `.eml`。
- `seed-user.mjs`：在临时 `DATA_DIR` 里建测试账号。
- `e2e.mjs`：断言脚本，输出逐步 JSON。
