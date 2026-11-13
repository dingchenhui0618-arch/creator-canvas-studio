# CI 安全扫描与 Node 版本锁（2026-11-14，第 83 轮 / v0.9.72）

上线清单里的 **B4（CI 安全扫描）** 与 **B9（Node 版本锁）** 是两条「平时看不见、出事很贵」的项：
前者决定一个 Key 误提交、一个生产依赖漏洞能不能在**合并前**被挡住；后者决定生产、CI、本机跑的是不是一个运行时。
这一轮把两条都做成能自动执行的闸门，并把「现在跑在哪个 Node 上」搬进后台，换机器 / 换版本时不用登服务器查。

## 结论

- CI 现在有三个 job 名字：`验证（Node 22.12.0）`、`验证（Node 24）`、`安全扫描（依赖漏洞 / 密钥）`。
- 密钥扫描覆盖 **538 个文本文件**（1092 个跟踪文件里排掉二进制），命中 **0**；规则与豁免在 `scripts/scan-secrets.mjs`，另有 9 条单测。
- 生产钉的 Node **22.12.0** 现在也是 CI 的一个矩阵项：生产跑的和 CI 验的是同一个版本，不再是「生产 22、CI 最新 22」。
- 启动时版本不对 → 退出码 **78**（EX_CONFIG）并打印一句能看懂的话；漏了 `--experimental-sqlite` 也一样，不再是一句 `ERR_UNKNOWN_BUILTIN_MODULE`。
- 后台「系统与版本」多一行「运行环境 Node 22.12.0 · 已验证」，来自 `/api/version` 的 `runtime` 字段（登录后才下发）。

## B4：CI 里的两道闸门

### 生产依赖漏洞

```
npm audit --omit=dev --audit-level=high
```

- 只看**生产依赖**：`devDependencies` 是 electron / vite / oxlint，不进服务器；把它们的告警也卡进来，只会让 CI 天天红、然后有人加 `|| true`。
- 命中 **high / critical** 直接红。当前结果 **0 条**（`prod: 49`、`dev: 379`、`optional: 89`）。
- 需要联网查 npm registry：CI 机器有网。真遇到 registry 抖动，红一次、重跑一次，比放行一条漏洞便宜。
- 不做自动修复（`npm audit fix`）：它会在 CI 里改依赖，把「检查」变成「提交」，风险不可控。

### 密钥扫描：为什么自己写

现成的 **gitleaks** 在 CI 里要单独下二进制、组织账号还要 license；更要紧的是本项目测试夹具里本来就有一堆假 Key（`sk-test-…`、`test-secret-…`），
必须靠 allowlist 才不误报，而 allowlist 一多，规则就没人敢改。规则集不大、场景固定，自己写反而能**直接进单测**——改规则先改测试，不是靠感觉。

规则（`scripts/scan-secrets.mjs` 的 `RULES`）：

| id | 抓什么 |
| --- | --- |
| `private-key` | `-----BEGIN … PRIVATE KEY-----` |
| `aws-access-key` | `AKIA…` / `ASIA…` |
| `github-token` | `ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_` |
| `slack-token` | `xoxb-` / `xoxp-` / … |
| `openai-key` | `sk-` 开头的模型 Key |
| `google-api-key` | `AIza…` |
| `jwt` | 三段 base64url 的 JWT |
| `url-credentials` | `scheme://user:pass@host` |
| `assigned-secret` | `apiKey: "…"` 这类**带引号的字面量** |
| `env-assignment` | `VQ_KEY_SECRET=…` 这类全大写变量赋值 |
| `tracked-env-file` | 被 git 跟踪的 `.env`（`.env.example` 除外） |

**三条口径**（都是被噪音逼出来的，见下一节）：

1. **只认字符串字面量**：`password: hash(pw, 10)`、`password: crypto.randomBytes(32)` 这种表达式不报。第一版没这个限制，`server/auth.mjs`、`server/password-reset.mjs`、`server/routes/project-share.mjs` 全被误报。
2. **测试与夹具目录豁免值类规则**：`test/`、`scripts/test-*.mjs`、`scripts/mock-*.mjs`、`e2e/` 里天生全是假 Key。**私钥与云厂商 Key 不豁免**——格式太特殊，出现在测试里基本就是真事故。
3. **赋值类要求「像随机串」**：长度 ≥ 20、至少 10 种字符、同时有字母和数字；纯 hex 单独放行（16 种字符的熵上限只有 4，按熵卡会把真 hex 口令全漏掉）。代价是**短的、纯字母的口令会漏报**，这是明说的取舍。

假 Key 的豁免写在**行尾**：`// secret-scan:allow`。比在脚本里维护一份路径 allowlist 诚实——谁都能看见「这里为什么放行」。

#### 调参过程（79 → 5 → 0）

第一版直接跑仓库：**79 处命中**，全是测试夹具和 `password: hash(…)` 这类表达式。
加上「测试目录豁免 + 只认字面量」：**5 处**，全是 `DATA_DIR=/var/lib/visionqa`、`BACKUP_SCRIPT=/opt/visionqa/…` 这种路径。
把 env 赋值的值限定成 `[A-Za-z0-9_-]{24,}`（不许 `/`、`.`）：**0 处**。
如果第一版就交出去，它大概会在第二次发版时被人加 `|| true` 关掉——那才是真失败。

### CI 结构

```
jobs:
  verify:    # matrix: [22.12.0, 24]，两个都绿才算过
  security:  # npm audit --omit=dev --audit-level=high + node scripts/scan-secrets.mjs
```

`verify` 的每一步都是既有的（tsc / oxlint / test / build），只多了一步 `node scripts/check-node.mjs`：
版本不在支持范围内就红得早一点、原因明确一点。

## B9：Node 版本锁

### 改动前的事实

| 位置 | 版本 | 来源 |
| --- | --- | --- |
| 生产 | **v22.12.0** | `deploy/production/install.sh` 的 `NODE_VERSION=22.12.0`，`/usr/local/bin/node` 软链到 `/usr/local/node` |
| CI | 22（最新） | `actions/setup-node` 的 `node-version: 22` |
| 本机开发 | v24.15.0 | 用户机器 |

三个版本不算「不一致」，但 **CI 从没在生产真正跑的那个小版本上验过**；而且没人知道「换到 26 会怎样」。

### 钉在哪

- `.nvmrc` = `22.12.0`：想跟生产一致的机器 `nvm use` 就行。
- `package.json` 的 `engines: { "node": ">=22.12.0 <25" }`：装依赖时提醒，不阻断（`engine-strict` 会连 Electron 开发一起卡住，收益不值）。
- CI 矩阵 = **22.12.0 + 24**：一个生产、一个开发；两个都绿才算过。
- `deploy/production/install.sh` 装完 Node 先比一次版本（`sort -V`），低于下限直接停，别装到一半才发现。

### 第一次在 22.12.0 上跑，就抓到 5 个文件

矩阵第一次跑：`验证（Node 24）` 637/637 绿，`验证（Node 22.12.0）` **604 个测试、5 个文件挂掉**：

```
not ok 12 - test/first-run.test.mjs
  TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts" for .../src/domain/first-run.ts
```

（同样中招：`help-center`、`list-view`、`scroll`、`sessions`——都是直接 `import '../src/domain/*.ts'` 的纯函数单测。）

原因：**Node 内置的 TS 类型擦除是 22.18 起才默认开启的**。本机 24 和 CI 的「22 最新」都默认能跑，
唯独生产钉的 22.12.0 不行——这正是加矩阵的意义：不加它，这 5 个文件会一直「看起来绿」。

修法：测试脚本加 `--experimental-strip-types`（22.6 起可用；24 已默认，带上是无害的）。**不是**把生产升到 22.18——
生产运行时跑的是构建后的 JS，不需要 TS 能力，为了测试去动生产版本是本末倒置。

也试过写自定义 loader（`module.register` + `typescript.transpileModule`）：项目里的 **TypeScript 7** 包根入口
只导出 `lib/version.cjs`（版本号），`transpileModule` 不在根导出里，要引 `typescript/unstable/*`。为一条测试路径引不稳定入口不值，放弃。

### 启动守门：退出码 78，不是裸栈

`server/index.mjs` 的**第一个 import** 是 `./node-guard.mjs`。ESM 按 import 顺序求值，所以它在 `config` / `storage` / `node:sqlite` 之前跑：

1. 版本低于 22.12 → 打印「Node x.y.z 太旧：需要 >= 22.12.0」+ 指路 `deploy/production/visionqa.service` 的 `ExecStart`，`process.exit(78)`。
2. 版本比验证过的 24 新 → 打印「没测过，出问题先退回 24」，**继续跑**（拒绝在更新的 Node 上启动太武断）。
3. 再**动态 import 一次 `node:sqlite`**：失败说明启动时漏了 `--experimental-sqlite`（Node 22 必需），打印人话后同样退出 78。
   动态 import 才能 catch——静态 import 失败会直接终止模块求值，接不住。

退出码 **78 是 EX_CONFIG**（`sysexits.h`），一眼能和服务崩溃区分。

### 后台可见

`/api/version` 在**登录后**多下发一个 `runtime`：

```json
{ "node": "22.12.0", "min": "22.12.0", "level": "supported", "supported": true }
```

`level` 有四个值：`supported`（验证过）/ `untested`（比 24 新）/ `too-old` / `invalid`。
后台「系统与版本 → 当前版本」显示成一行「运行环境 Node 22.12.0 · 已验证 · 支持 22.12.0 起」。
**匿名探针拿不到**：Node 版本和启动时间一样属于部署细节，登录后才下发。

## 验证

- 本机（Node 24.15.0）：`npm test` **637/637**（本轮 +16：密钥扫描 9、Node 版本 7）；oxlint 0 error / 7 warning（既有）、`tsc -b` 干净、`npm run build` 通过。
- CI：`验证（Node 22.12.0）` 与 `验证（Node 24）` 都是 **637/637**（22.12.0 第一次跑挂 5 个文件，见上一节），`安全扫描` 两个步骤通过。
- 密钥扫描：`node scripts/scan-secrets.mjs` → **538 个文本文件、0 处命中**（另 554 个二进制/超限文件跳过：截图、字体、压缩包）。
- 生产依赖：`npm audit --omit=dev --audit-level=high` → **0 条漏洞**。
- 生产（v0.9.72）：`/api/version` = 0.9.72，登录后 `runtime.node` = **22.12.0**、`level` = `supported`；`/api/health` ok；后台系统页那一行见截图。
- 生产启动日志的 `listen` 事件带 `"node":"22.12.0"`，翻日志能对上当时跑的版本。
- 端到端证明扫描器真会报：把一把假 Key 写进 `src/`、`git add` 后跑 `node scripts/scan-secrets.mjs --staged` → **1 处命中、退出码 1**（输出只打 `9f3a…f48`），随后清掉暂存与文件。

## 边界

- 密钥扫描**只扫 git 跟踪的文件**：未被跟踪的 `.env`、构建产物、`node_modules` 不在范围（它们在 `.gitignore` 里，本来也不该进仓库）。
- 赋值类规则**只认带引号的字面量**与全大写 env 赋值；`const K = someFunction()` 这种间接赋值不在覆盖范围。
- 短的、纯字母的口令会漏报（判据要求长度 ≥ 20 且像随机串）。
- `npm audit` 依赖 npm registry 的漏洞库：它只报**已知**漏洞，0 条不等于安全。
- Node 版本锁不是运行时隔离：更新到 25 以上会继续跑（只打警告），真出问题靠启动时的 `node:sqlite` 探测。
- CI 的 22.12.0 与生产是同一个二进制版本，但**不是同一台机器**：数据库 / 文件系统行为仍以生产为准。
- 单测跑在 `--experimental-strip-types` 上：只擦类型，不转 enum / namespace / 参数属性。`src/domain` 现在没有这类写法，以后加会被这把开关挡住（挡在测试里，不是挡在线上）。

## 复验命令

```
node scripts/check-node.mjs       # 当前 Node 是否在支持范围
npm run scan:secrets              # 扫所有 git 跟踪的文件
npm run scan:secrets -- --staged  # 只扫已暂存（pre-commit 用）
npm audit --omit=dev --audit-level=high
npm test
```

本轮提交 `9f4cf5b`（代码 + 测试 + 文档 + 2 张生产截图）、`15061cb`（`--experimental-strip-types`，为让单测在 22.12.0 上跑）；CI **43491423413 success**，第一次矩阵跑 `43490781275` 红在 22.12.0 的 5 个文件上（见「第一次在 22.12.0 上跑」一节）。

生产上确认版本：`curl -s https://visionqa.wavisionai.cn/api/version`（匿名只有版本号）；登录后看 `runtime`，或后台「系统与版本」那一行。
