# r335 · 划过那一半：107 处悬停过渡补齐 + 量具把 25 条 currentColor 连带变化当成硬切（v0.9.307 / v0.9.308）

## 一、结论

按下那一层（r331–r334）清零之后，同一套判据换到**鼠标划过**上：136 颗按钮里划过有变化 95 颗，
线上 0.9.306 **划过硬切 1 条**；静态门禁把 `src/styles` 每条 `:hover` 过一遍，**156 条属性没有过渡**
（107 个选择器）。这一轮补完：**107 处追加过渡 + 5 处并进已有声明**，静态 0 条，线上量到 **划过硬切 0**、
**按下硬切 0**。

读数（同一份脚本 `scripts/audit-press.mjs`、同样 10 趟、136 颗按钮，1440×1000）：

| 产物 | 按下硬切 | **划过硬切** | 连带变化 | 有反馈（按下 / 划过） |
| --- | --- | --- | --- | --- |
| 0.9.304 `index-CDUNYuqb.js` | 32 | 13 | 27 | 106 / 95 |
| 0.9.306 `index-BgRdMhjN.js`（本轮 before，线上原件） | 0 | **1** | 27 | 124 / 95 |
| 0.9.307 `index-CyOHShxi.js`（第一版，补错了，见五） | **3** | 0 | 27 | 124 / 95 |
| 0.9.308 `index-B2DSgDYY.js`（本轮 after，线上原件） | **0** | **0** | 27 | 123 / 95 |

## 二、这一轮量的是「划过」

判据与按下那一层完全一样：**变了的属性必须能在这份 CSS 里找到过渡**，找不到（或 duration 0）就是硬切。
不用另开一趟鼠标移动——按下之前本来就要把鼠标移到元素中心（`pressOne` 的 ② 那一拍就是 hover 基线），
所以 `rest`（鼠标在中性点）→ `hover`（鼠标到元素中心）这份 diff 与「它走不走过渡」落在同一趟里：

- 读数：`readState` 在 hover 那一拍也带上 `transitionProperty` / `transitionDuration`（规范里过渡取的是
  **after-change style**，就是这一份）；
- 产物：`buttons[].hoverChangedVsRest` + `buttons[].hoverHardCuts`；汇总 `hoverWithFeedback` /
  `hoverHardCuts` / `hoverHardCutProps`；报告里单开一节「划过有变化但还是硬切」；
- 量具守卫：`test/audit-press-motion.test.mjs` 多了 2 条反证（把输入换成空数组、或换查按下那张过渡表，
  报告都会打印「划过硬切 0」而页面没变好），并钉住 `hoverDerived` / `derivedOnPress` 两行。

## 三、量具自己错在哪：26 条里有 25 条不是反馈

**没有可见边框时，computed 的 `border-color` 就是 `currentColor`** —— `color` 一变它必然跟着变，
元素写 `border: 0` 也一样。第一版量具只按「变了、且不在过渡表里」判硬切，在 0.9.306 上报出
**26 条划过硬切**，逐条看数据：25 条的 `border-color` 与 `color` 是同一对数值（如
`rgb(93,93,93) → rgb(17,17,17)`），元素写的是 `border: 0`，没有任何边框可画——**那条变化看不见，
它不是反馈，只是 color 的另一种写法**。真实的那一条是顶栏搜索格：

- `shell.css :: .vq-search--trigger:hover :: color`（`rgb(111,111,111) → rgb(93,93,93)`）——
  r334 给 `.vq-search` 补的是 `background-color / border-color / box-shadow`，没带 `color`。

修法分两头：**量具**多读一行四边宽度（`borderWidths`），两边宽度全 0 的 `border-color` 变化单列成
`hoverDerived` / `derivedOnPress`（如实记录、不进 `changed`、不进硬切，汇总里报条数）；
**静态门禁**同样加了 `declaresVisibleBorder()`，写 `border: 0` 的元素不再被要求给 `border-color` 配过渡。

顺带把 r334 的账重算了一遍：用修好的量具再量 0.9.304 原件（`index-CDUNYuqb.js`）——
**按下硬切仍是 32 颗按钮 / 43 条属性**，按下这一层的连带变化为 **0**，所以 r334 当时的数字成立、
不用改；同一份产物两次跑，`有反馈 106 / 105`、`候选 21 / 22`、`settledRescued 0 / 1` 会抖，
这是两帧采样的老问题（r331–r334 已记过），硬切那一栏两次都是 32。

## 四、补了什么

**追加 15 份样式文件的过渡段（107 个目标）**，一份一段、时长与缓动跟按下那一层同一套
（`--dur-1` / `--ease-out`）：

| 文件 | 目标 | 属性 |
| --- | --- | --- |
| `src/styles/agents.css` | 26 | color + background-color + border-color + filter |
| `src/styles/projects.css` | 12 | color + border-color + text-underline-offset + text-decoration-thickness |
| `src/styles/rooms.css` | 10 | color + background-color + border-color |
| `src/styles/radar.css` | 8 | color + background-color + border-color |
| `src/styles/canvas.css` | 7 | color + background-color + border-color |
| `src/styles/review.css` | 6 | color + background-color + border-color |
| `src/styles/overview.css` | 5 | color + background-color |
| `src/styles/runs.css` | 4 | color + border-color |
| `src/styles/console.css` | 3 | color + background-color + border-color |
| `src/styles/board.css` | 2 | color + background-color + border-color |
| `src/styles/shell.css` | 20 | color + background-color + border-color |
| `src/styles/promos.css` / `src/styles/legacy-fix.css` / `src/styles/local-workspace.css` / `src/styles/media-lightbox.css` | 1 each | 运营位描边 / 模板卡阴影 / 会话行底色 / 灯箱关闭键 |

**并进已有声明的 5 处**（自己再写一条同权重、位置更靠后，会把原来那条整条盖掉）：

- `shell.css .vq-link` 补 `text-underline-offset`（r334 那条只有底色与文字色）；
- `shell.css .vq-search` 补 `color`——它就是上面那条真硬切；
- `overview.css .ov-cap-action` 补 `text-underline-offset`（r334 那条只有底色与圆角）；
- `radar.css .radar-taken-main > svg` 补 `color`（原来只有 opacity）；
- `share.css .share-button` 补 `background-color`（原来只有描边与文字色，主按钮划过换底色是硬切）。

**BEM 修饰类不自己写**：`.vq-nav-item--utility` / `.vq-search--trigger` / `.share-button--primary`
这类 `X--mod` 的元素在 JSX 里同时挂着 `X`，过渡来自基类那一条；静态门禁为此加了
`coversFamily()`（只认**单段选择器**，而且要求 required 的每个类都能在过渡那条里找到自己或它的基类——
否则 `.vq-sidebar-account-row--guest .vq-sidebar-account-action` 会被祖先那条误当成覆盖）。
**白名单因此清空**：r334 那种「跨类、静态推不出来」的例外，悬停这一层一条都不需要了。

## 五、第一版补错了一处，量具当场抓到

第一次上线（0.9.307 / `index-CyOHShxi.js`）把 `.vq-nav-item--utility` 与 `.vq-search--trigger`
也写进了追加段。它们是 `.vq-nav-item` / `.vq-search` 的同权重、位置更靠后的选择器——
浏览器取后一条，于是基类那条的 `transform`（按下 1px 位移）与 `box-shadow`（焦点环）**被整条挤掉了**。
按下巡检从 **0 变成 3**（侧栏「帮助与协议」「设置」各一条 transform、顶栏搜索格一条 box-shadow），
划过那一栏是好的（0）——**一边对了、另一边退回去，这正是两栏都留着的原因**。

修法：把那 3 个修饰类从追加段里拿掉，缺的属性并进基类那条；同时加两条门禁——
静态层 `coversFamily()`（前面那份过渡认得出 BEM 家族），以及一条新守卫
「**追加段里不能出现「基类已有过渡」的 BEM 修饰类**」（判的是**最后一个复合选择器**上的类，
祖先的类不算）。这条守卫在修好前是红的，修好后绿。

## 六、门禁与发布

- 静态门禁 `test/press-motion.test.mjs`：**13 条**（r334 六条 + r335 七条），
  新增 `:hover` 全量体检（**全局过渡池**：CSS 不分文件，同一个类在哪一份里写 transition 都算数）、
  BEM 家族覆盖、边框可见性、非动画属性清单（`cursor / text-decoration / border-style / background-image / display`）、
  悬停白名单与它的「没有烂掉」检查，以及三组反证（删掉追加段 / 拿掉并进去的每一条 / BEM 覆盖守卫）。
- 量具守卫 `test/audit-press-motion.test.mjs`：**5 条**（r334 三条 + r335 两条）。
- `npm test` **2179 / 2179**（+9）。第一次跑挂过一条 `test/gateway-idempotency.test.mjs`（`--test-concurrency=4`
  下的并发抖动：单跑 9/9 通过，重跑整套 2179/2179 通过），与这一轮改动无关。
- `tsc -b` 干净；`oxlint` 0 error / 30 warning（774 文件）；密钥扫描 1234 个文件无命中。
- 入口 `index-B2DSgDYY.js`（873,536 B，产物里含 `0.9.308`）；发布标签 `20261127-0135-r335hover`；
  回滚点 `/opt/visionqa/releases/20261126-172531-20261127-0135-r335hover.tar.gz`；
  公网 `/api/version` **0.9.308**、health ok（redfox / vision / llm 三项 true，templates 27）、
  新入口 200、上一版入口（`index-CyOHShxi.js`）404，`visionqa` / `visionqa-internal` / `visionqa-demo` 三个服务 active。
- 提交 `9f53375`（22 文件，+738 / −16），CI **45868426957 success**（Node 24 / Node 22.12 / 安全扫描三格全绿）。
- 中间那版 0.9.307 是同一轮的过渡产物（标签 `20261127-0115-r335hover`，回滚点
  `20261126-171622-20261127-0115-r335hover.tar.gz`，入口 `index-CyOHShxi.js`），20 分钟内被 0.9.308 取代。

## 七、证据为什么是读数，以及这一层的边界

- **划过与按下一样，静态截图看不出 120ms**：悬停的**终值**在改动前后完全相同（改的是过程），
  所以没有「before / after 对比图」这种证据可给；这一轮的证据是两栏读数（划过硬切 1 → 0、按下硬切 0 → 0）、
  以及第一版那 3 条被打回来的硬切（0.9.307 的 press.json 留在 `.tmp-hover/after/`）。
- 划过只对**十趟里那 136 颗按钮**有实时读数；表格里那些行 / 卡片 / 链接（比如 `.rooms-row`、
  `.qc-conv`、`.cv-tool`）只有静态门禁，没有浏览器读数——目标收集器只收
  `button / [role=button] / .vq-card-open`，扩到「所有可悬停元素」是下一层的事。
- 判据只认 **computed 的 transition-property / -duration**：不看两帧读数等不等于终值（那是采样抖动的口径），
  也不给「该不该有过渡」下判断（`<a>` 的下划线本身不是可动画属性，只动 offset 与 thickness）。
- `--shots all` 那类局部截图里含外壳（侧栏账号行上有登录手机号与邮箱），**不许进 docs/**；这一轮没有入库任何截图。
