# 中文统一到阿里巴巴普惠体 3.0（r308 / v0.9.281）

日期：2026-11-24。用户要求：「调整下生产端全部的字体类型 Alibaba PuHuiTi 3.0 45 Light，用这个字体整体统一替换掉现在的中文字体」。

## 改了什么

| | 改前 | 改后 |
| --- | --- | --- |
| 中文 | 系统黑体（Windows 微软雅黑 / Mac 苹方 / Noto Sans SC） | 自托管「阿里巴巴普惠体 3.0」，45 Light 正文 + 65 Medium 强调 |
| 拉丁 | Figtree / Geist Mono（自托管拉丁子集） | 不变 |
| 等宽 | Geist Mono，中文掉回系统字体 | Geist Mono 之后接普惠体，等宽里的中文也统一 |

字体栈（src/styles/tokens.css 与 src/styles/shell.css 各一份）：

```
--font-ui:   'Figtree', 'Geist', 'Alibaba PuHuiTi 3.0', 'PingFang SC', 'Microsoft YaHei UI', 'Microsoft YaHei', system-ui, sans-serif;
--font-mono: 'Geist Mono', 'Cascadia Mono', 'Consolas', 'Alibaba PuHuiTi 3.0', ui-monospace, monospace;
```

拉丁仍在最前：Figtree 只带了拉丁子集，中文自然落到普惠体，所以英文与数字的排版不动，只把中文换掉。系统黑体留在末尾兜底——分片 404 或断网时不至于变成空白。

## 为什么是两档字重，而不是只有 45 Light

按要求正文用 45 Light。但界面上有大量 500/600/700 的标签、按钮、卡片标题，只挂 Light 一档会让浏览器对粗体做伪粗（把 Light 描边加厚），中文会糊成一团。所以带上 65 Medium，并这样声明覆盖区间：

| 文件 | @font-face 声明 | 谁落到它 |
| --- | --- | --- |
| AlibabaPuHuiTi-3-45-Light | `font-weight: 100 400` | 正文（400）、辅助文字（300） |
| AlibabaPuHuiTi-3-65-Medium | `font-weight: 500 900` | 标签与标题（500/600/700/800） |

400 落在 Light、600/700 落在 Medium，全程不触发伪粗。要「全站只有 Light」只需把 Medium 那一段删掉、并把 Light 声明改成 `100 900`，但界面层级会塌成一片。

## 分片：只下页面里真出现的字

字体用 cn-font-split 切成按 unicode-range 的 woff2 分片（45 Light 165 片、65 Medium 168 片，单片最大 70KB，共 10.7MB 在仓库里），样式表放在 public/fonts/puhuiti/puhuiti.css，由 index.html 单独 link，不塞进应用主样式。

浏览器只请求页面里真正出现的字块。本机实测（全新 context，1440×900）：

| 页面 | 分片数 | 传输量 |
| --- | --- | --- |
| 登录页 | 32 | 1041 KB |
| 快捷创作 | 33 | 1077 KB |
| 作品 | 32 | 1041 KB |
| 视觉评审 | 34 | 1082 KB |

也就是首访每页约 1.0MB 字体（woff2 本身已压缩，gzip 对它无效），命中缓存后不再请求。样式表自身 288KB，线上实测 Content-Encoding: gzip（约 30KB）。

## 踩到的坑：两处 --font-ui

tokens.css 的 :root 与 shell.css 的 .vq-scope 各写了一套字体栈，工作台整片都在 .vq-scope 里。只改 :root 时登录页变了、工作台里一个字没变——第一版截图就是被这个骗过去的（本地 computedStyle 量出来还是 Geist, Noto Sans SC, ...）。现在 test/fonts-puhuiti.test.mjs 同时钉住两处，并禁止任何 --font-* 声明里再出现 Noto Sans SC / 苹方 / 微软雅黑。

## 布局影响

换字体等于换字宽，320–1440 五档 × 七个页面扫了一遍（工作台 / 快捷创作 / 作品 / 模板库 / 视觉评审 / 运行记录 / 设置）：

- 六个页面全部 scrollWidth == innerWidth，没有元素越界、没有文字被裁。
- 唯一一处：设置页账号卡在 320 宽出 26px 横向滚动，是 vq-account-actions 里那串长邮箱撑的。A/B 同屏量过：换字体前 347、换后 346——与本轮无关，是 r202 那次只按短账号验证留下的缺口。

## 门禁

- 全量 1971/1971 测试（新增 test/fonts-puhuiti.test.mjs 5 条：字体栈顺序、两处都要改、link 关系、每个 url() 指向真实分片且单片 <100KB、字重区间与不许有 local()）。
- npx tsc --noEmit 干净、oxlint 0 error（25 warning 均为既有规则）、npm run build 通过、密钥扫描 1088 个文件无命中。
- 截图：docs/font-puhuiti-compare.png（改前 / 改后同屏同框）、-1440、-overview-1440、-390，上线后生产实拍 docs/font-puhuiti-prod.png（左侧栏已裁掉，避开账号信息）。

## 上线

生产 v0.9.281，入口 index-CmeWEqbo.js，health ok templates 26，两服务 active，回滚点 20261124-055546-v0.9.281-fonts（scripts/rollback.sh --to 1 回 0.9.280）。

## 还差什么

1. /fonts/ 没有长缓存头：.woff2 的 URL 是内容哈希，本该 immutable 一年，现在只靠 ETag 重新协商——每次访问多 30 多个 304。nginx 模板加一段正则 location 即可，本次没动线上 nginx。
2. 交付包、找回密码邮件、A4 评审稿仍是系统字体：交付包要能离线打开、邮件由收件端决定，换 webfont 反而更脆。
3. 字重只有两档。需要 55 Regular / 85 Bold 的话，按同样流程再切两套（每套 +5.4MB 仓库、首访 +0.5MB）。
