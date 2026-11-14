# 分享离线包也带校验页（v0.9.134，2026-11-15）

## 问题

v0.9.133 把「校验.html」做进了交付包：封存给客户、剪辑，收包人拖进去就能自己核对。可还有一条更常见的路——**只读分享的离线包**。拿到链接的甲方、剪辑、拍摄多数连账号都没有，下载完也不会回来问「这份全不全、有没有坏」；一份发出去的东西如果要靠发件人自证，就不算自带证据。

## 做法

- `server/project-share-bundle.mjs`：`buildShareBundle` 先把包里其它条目（现场页、评审对照、两版对照、说明、帧图、评审补图）排成一个数组，再调 `packageVerifyHtml` 生成页面，最后 `splice` 回 `说明.txt` 后面，再 `buildZip`。顺序只有这一种：清单要覆盖「其它全部条目」，所以页面必须最后生成、插回中间。
- `server/package-verify-page.mjs`：新增 `packageKind`（默认 `交付包`），只改纸的标题（`title + ' · ' + kind + '校验 · VisionQA'`）。判据、脚本、样式、CSP 提示都没动，交付包那条路径的默认值不变。
- `shareBundleNote`：多一行 `校验.html`，说清怎么用、不上传不联网。
- 分享页（`src/pages/ProjectSharePage.tsx`）「带走整套」那块补一句，让人在下之前就知道包里有这一页。
- `test/share-bundle-verify.test.mjs`（新，4 条）：匿名下载的包里有一页且紧跟说明、页面清单与 zip 条目逐条对得上（名字 / 字节 / CRC32）、页面不联网无外链、清单里不出现作品编号 / 模板画布 id / 账号 / token / 原始素材路径。

## 本地实测（真服务 + 匿名下载 + 真 Chrome + file:// + 真拖文件）

fixture 是本地 `prj_r134demo`（v4，5 镜，2 次评审），打开只读分享并勾上两版对照，匿名 `GET /download/share/project/<token>/bundle.zip?tz=480`（不带 cookie）：

| 检查 | 读数 |
| --- | --- |
| 离线包 | 266,276 B、10 条；顺序：现场页.html、评审对照页.html、两版对照页.html、说明.txt、**校验.html**、frames/shot-01…05.jpg |
| 校验页 | 22,722 B；清单 9 条（不含自己）；标题「毛衣折叠收纳法 · 第三版 · 离线包校验 · VisionQA」 |
| 好包（1440） | 10 行；chip「都对得上」；「9 个文件都对得上：字节数与 CRC32 都和打包时记下的清单一致。」 |
| 整包 SHA-256 | `eaeab9a3b7a237b2873c8026960cf52bcf4e8ace841d1b1745fae79c79a0c1a2`（64 位，本地算） |
| 改一个字节 | 「1 个文件对不上」；`frames/shot-01.jpg` 算出 9629C52C，清单里 50FE0813；只有这一行红 |
| 截断 | 沿用同一页的判据：「找不到 zip 的尾记录」，不冒充通过（由 v0.9.133 的用例覆盖） |
| 390 | `clientWidth` 390 = `scrollWidth` 390，表宽 334，CRC32 列收起 |
| 网络 | 3 个 `file://` 请求（自己 + 两个本地字体），**0 条 http(s)**；页面异常 0 |
| 分享页文案 | 「…包里还带一页 校验.html：把 zip 拖进去就能自己核对，坏了一条会点名…」 |
| 页面里不出现 | 作品编号 `prj_r134demo`、账号前缀 `u_`、`flow_`、分享 token、`/media/` |

截图：`docs/share-verify-2026-11-15.png`（好包）、`docs/share-verify-bad-2026-11-15.png`（改一字节）、`docs/share-verify-390-2026-11-15.png`（390）、`docs/share-verify-sharepage-2026-11-15.png`（分享页那块文案）。

## 坑

1. **顺序**：清单必须覆盖其它全部条目。先生成页面、后拼帧图，会让清单少几条；正确顺序是先排好数组、再生成页面、再插回说明后面。
2. **标题写死**：上一版把「交付包校验」写进 title，分享包复用时会写错。抽成 `packageKind` 参数，默认值保持「交付包」，旧测试原样通过。
3. **中文文件名**：页面脚本按 UTF-8 读中央目录，中文名不需要额外编码处理；`<script type="application/json">` 里的 `<` 仍按 v0.9.133 转成 `\u003c`。
4. **file:// 字体**：本地字体取不到会去 `file:///D:/fonts/...`，回退系统字体，不影响核对。

## 发现但没做

- 整包 SHA-256 仍然只能跟发件人对那串数；**分享页上没有这串数**（那一页要能离线打开，不能反过来依赖在线地址）。
- 不验签名：只对字节，不说「谁给的」。
- v0.9.133 及以前下载的离线包没有这一页；不回头改已下载的文件。
- 分享包里的页面没有「收据 / 回执」这类反向证明，收包人核对完不会自动回话。

## 回退

`bash /opt/visionqa/ops/rollback.sh --to 1` → v0.9.133；`--to 2` → v0.9.132。新页只是新包多一个文件，旧版本不认识也不读它，没有数据迁移。

## 改动文件

- `server/package-verify-page.mjs`（`packageKind` 参数）
- `server/project-share-bundle.mjs`（清单顺序 + 生成页面 + 说明一行）
- `src/pages/ProjectSharePage.tsx`、`src/api/projects.ts`（文案）
- `test/share-bundle-verify.test.mjs`（新增 4 条）
- `README.md`（二百零一节 + 作品能力行）、`docs/share-verify-*.png`
- `package.json` / `package-lock.json`（0.9.134）
