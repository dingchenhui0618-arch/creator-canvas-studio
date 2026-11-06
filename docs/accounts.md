# 账号与会话

结论先行：**登录不再是前端 mock，账号真的落在服务端数据库里**。密码用 scrypt 存哈希，会话是服务端随机
token + HttpOnly cookie，浏览器里拿不到 token，也拿不到密码。没有接的是「找回密码」「邮箱验证」「角色权限」
这三块——它们都写在下面的「没做的部分」。

## 1. 一次登录到底发生了什么

1. 前端 `POST /api/auth/login`（`credentials: same-origin`，不带任何 Authorization 头）。
2. 后端 `server/auth.mjs` 从 `data/auth.db` 查用户，用 scrypt 校验密码；邮箱不存在时**也跑一次 scrypt**，
   避免用响应时间探测「这个邮箱有没有注册」。
3. 校验通过 → 生成 32 字节随机 token，**只把 sha256(token) 存进 sessions 表**，token 明文只出现在
   `Set-Cookie: vq_session=…; HttpOnly; SameSite=Lax; Path=/; Max-Age=…`。
4. 前端只缓存 `{ id, email, name, workspace, kind }` 做首屏渲染；刷新后先渲染缓存，再拿
   `GET /api/auth/me` 校验，401 才清缓存回登录页。

## 2. 接口

| 方法 | 路径 | 成功 | 失败 |
| --- | --- | --- | --- |
| GET | `/api/auth/config` | `{ registrationEnabled, minPasswordLength, demoAccount: {email,password} \| null }` | — |
| POST | `/api/auth/register` | 201 `{ user }` + Set-Cookie | 400 `{error, field}` / 409 `field:'email'` |
| POST | `/api/auth/login` | 200 `{ user }` + Set-Cookie | 400 `field` / 401 `field:'form'` / 429 |
| POST | `/api/auth/logout` | 204 + 清 cookie | — |
| GET | `/api/auth/me` | 200 `{ user }` | 401 `{ error }` |

`user = { id, email, name, workspace, kind }`，`kind` 取 `account | demo | guest`。
错误里的 `field` 只有 `email / password / name / form` 四种，登录失败一律 `form` 且文案统一为
「邮箱或密码不正确」——不区分「邮箱不存在」和「密码错」。

## 3. 安全上具体做了什么

| 项 | 做法 | 为什么 |
| --- | --- | --- |
| 口令存储 | scrypt(N=16384, r=8, p=1) + 每用户 16 字节随机盐，格式 `scrypt$N$r$p$salt$key` | 单机 CPU 可控，比 bcrypt 少一个原生依赖 |
| 会话 token | 32 字节随机，库里只存 sha256 | 拖库拿不到可直接使用的会话 |
| 会话投放 | HttpOnly + SameSite=Lax + Path=/，生产加 Secure | 前端 JS 读不到 token；跨站表单拿不到 cookie |
| 登录限流 | 进程内滑动窗口：同 IP+邮箱 10 分钟内失败 8 次锁 | 挡住最省事的暴力破解 |
| 写请求来源 | POST 带 Origin 且 Host 不一致直接 403 | cookie 会话的最低成本 CSRF 防护 |
| 越权访问 | `VQ_REQUIRE_AUTH=1` 时除 `/api/auth/*`、`/api/health`、`/api/version` 外全部要登录 | 默认关闭是为了不影响本机演示 |
| 故障态 | 网络失败保留缓存不清会话 | 后端没起来不应该逼用户重新登录 |

## 4. 环境开关（默认值都在「不安全」一侧，生产必须显式写）

| 键 | 默认 | 生产 | 作用 |
| --- | --- | --- | --- |
| `VQ_REQUIRE_AUTH` | 关 | **1** | 受保护接口要求登录，未登录返回 `{error:'未登录', loginRequired:true}` |
| `VQ_SECURE_COOKIES` | 关 | **1** | 会话 cookie 加 Secure（必须走 HTTPS） |
| `VQ_DEMO_ACCOUNT` | 开 | **0** | 关掉演示账号 seed，`/api/auth/config` 的 `demoAccount` 返回 null，登录页整块隐藏 |
| `VQ_REGISTRATION` | 开 | 按需 | 内部系统建议 0，由管理员建号 |
| `VQ_SESSION_DAYS` / `VQ_REMEMBER_DAYS` | 7 / 30 | 7 / 30 | 会话时长 / 勾「记住我」后的时长 |
| `VQ_DEMO_EMAIL` / `VQ_DEMO_PASSWORD` | 后端常量 | 不填 | 只在演示账号开启时生效 |

cookie 名固定 `vq_session`，不开放配置。

## 5. 验收

`node scripts/test-auth.mjs` 会起一个**临时实例**（独立端口 8799 + 临时 DATA_DIR），跑完删干净，16 项全过：

```
PASS  服务启动 /api/health
PASS  GET /api/auth/config 200 且带演示账号
PASS  未登录访问 /api/templates 返回 401
PASS  演示账号能真登录
PASS  错误密码返回 401 且 field=form
PASS  不存在的邮箱与密码错同样 401
PASS  注册返回 201 并直接下发会话
PASS  重复注册返回 409 field=email
PASS  弱密码被拒 400 field=password
PASS  GET /api/auth/me 用注册 cookie 返回用户
PASS  登录后访问 /api/templates 放行
PASS  登出返回 204
PASS  登出后旧 cookie 失效
PASS  数据库里查不到明文会话 token
PASS  数据库里没有明文密码
PASS  口令用 scrypt 存储
全部通过：16 项
```

界面侧另有一次真实点击验收：注册新账号 → 直接进工作台（`下午好，试用账号`）→ 退出登录 → 回登录页 →
错误密码给出「邮箱或密码不正确」→ 演示账号登录 → 进工作台。截图见 README 第六节。

## 6. 没做的部分（别当成已经有了）

- **找回密码**：登录页的「忘记密码？」只弹一句「还没接入，请联系管理员」，不假装修好了。
- **邮箱验证**：注册即生效，不收验证码，也不校验邮箱归属。
- **角色与权限**：只有「登录 / 未登录」两个状态，没有管理员角色。所以后台管理版的用户列表页还没接
  真实用户接口，只展示当前会话，页面上写明了这一点。
- **多工作区**：`workspace` 字段是固定的「个人工作区」，切换入口点了只提示还没开放。
- **第三方登录**：没有微信 / 邮箱 OAuth。
- **密码明文风险**：VisionQA Canvas（第三方，不在本仓库）的用户表存了 `password_plaintext`，与本仓库无关，
  但同一台机器上跑时要心里有数。
