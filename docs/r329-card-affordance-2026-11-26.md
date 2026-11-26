# r329 抬起 = 能点：卡片的手感与键盘（v0.9.301，2026-11-26）

## 结论

一排卡片悬停会抬起来，就是在说「这张卡能点」。但**可点不等于可达**：
工作台首屏那四张能力卡里，有三张抬起来了却只有右下角那行小字能点（点标题、点正文都没反应）；
模板库卡片反过来——鼠标点得动、**键盘永远到不了**。这一轮把「抬起 = 能点」落成一条共用规则
`.vq-card-open`（沿用 r326 在运营位上做的那套 `::after` 热区），并给两处不该抬起的卡片摘掉了抬起。

## 改之前（真浏览器 + CDP 真输入，1440×1000，入口 `index-ByDh_Wgb.js` / v0.9.300）

| 位置 | 命中元素（卡中心） | 指针 | 卡内可用入口 | 点卡片正文 |
| --- | --- | --- | --- | --- |
| 能力卡 01 找爆款 | `H3` | `auto` | 0 个 | 路由**没变**（还停在工作台） |
| 能力卡 02 模板库 | `H3` | `auto` | 0 个 | 没变 |
| 能力卡 03 我的资产 | `H3` | `auto` | 0 个 | 没变 |
| 能力卡 04 出片与评审 | `H3` | `auto` | 0 个 | 没变（这张**本该**不变） |
| 运营位第 1 条（r326 的账） | `BUTTON.vq-promo-cta` | `pointer` | — | 跳到 `#/rooms`（对） |
| 模板库卡片 | `SPAN.template-cover-empty` | `pointer` | 0 个 | 抽屉打开（对） |

键盘那条更值得记：模板库按 Tab，第 27 下才落进卡片，落的是 `button.template-adapt`「用这条改编」——
**键盘用户只能进「改编」，没有一条能只是打开这条卡片的路**（详情、分享、复制链接都在抽屉里）。
作品页的卡片是 `<button>`（第 7 下就到了），所以这不是「卡片天生不可达」，是这一张写错了标签。

## 做法：一条共用规则 + 三处接线 + 两处摘掉

`src/styles/motion.css` 新增 `.vq-card-open`：

1. **热区**：卡片里那颗真按钮的 `::after` 用 `position: absolute; inset: 0` 铺满整张卡。
   鼠标在卡上任何地方都是指针、点卡任何地方都进得去、Tab 只有这一格、回车照常触发；
   不给容器挂 `onClick`，也不把按钮套进按钮。
2. **按下不许位移**：`.vq-card-open.vq-card-open:active { transform: none }`。
   这是 r326 在运营位上真机实测出来的坑——带 `transform` 的元素会成为绝对定位后代的**包含块**，
   按下的一瞬间热区的参照从整张卡变成按钮自己，`mousedown` 落在按钮、`mouseup` 落回卡片，
   合成出来的 `click` 落在卡片上：点了什么也不会发生，而编译、样式、单测全都看不出问题。
   按下反馈改成热区罩住的那张卡压暗一档（`--line-faint`），比 1px 位移更像「按到了这张卡」。
3. **按钮自己不许定位**：一按钮化，`::after` 的参照就从卡片变成按钮，热区只剩按钮那么大。

| 位置 | 谁当入口 | 变化 |
| --- | --- | --- |
| 能力卡 01 / 02 / 03 | 原来那颗「去检索 / 去模板库 / 去我的资产」 | 加 `.vq-card-open`，卡片加 `position: relative` |
| 模板库卡片 | 新增的标题按钮 `.template-open`（`<strong>` 里包一颗真按钮） | `<article onClick>` 拿掉 |
| 运营位卡片 | 原来那颗 CTA | r326 的 `::after` 规则搬进共用层 |

两处**摘掉**抬起：能力卡 04（有两个去处，点卡上哪一处都说不清该去哪，所以不整卡可点）、
后台运营位预览卡（只读预览，点了什么也不会发生）。

## 改之后（入口 `index-DvhCcfhI.js` / v0.9.301）

| 位置 | 命中元素 | 指针 | 卡内可用入口 | 点正文 |
| --- | --- | --- | --- | --- |
| 能力卡 01 | `BUTTON.ov-cap-action.vq-card-open` | `pointer` | 1 个 | **跳到 `#/radar`** |
| 能力卡 02 | 同上 | `pointer` | 1 个 | **`#/templates`** |
| 能力卡 03 | 同上 | `pointer` | 1 个 | **`#/assets`** |
| 能力卡 04 | `H3` | `auto` | 0 个 | 没变（故意） |
| 运营位第 1 条 | `BUTTON.vq-promo-cta` | `pointer` | 1 个 | `#/rooms`（回归通过） |
| 模板库卡片 | `BUTTON.template-open.vq-card-open` | `pointer` | 1 个 | 抽屉打开 |

键盘：模板库第 27 下落在 `button.template-open.vq-card-open`（标题那颗），**回车 → `#/templates` → `#/templates/tpl_r329_probe`，抽屉打开**；
工作台第 25 下落在 `button.ov-cap-action.vq-card-open`，回车 → `#/radar`。

![改之前：点了能力卡「找爆款」的正文，页面还停在工作台](docs/r329-before-ovcap-body.png)

![改之后：同样点正文，进了爆款雷达](docs/r329-after-ovcap-body.png)

![改之后：Tab 落到卡片标题那颗真按钮上按回车，抽屉打开（之前第 27 下落在「用这条改编」上）](docs/r329-after-template-open.png)

## 量法上的三个坑

1. **卡片自己的 `cursor` 会骗人**。运营位从 r326 起就是整卡可点，但
   `getComputedStyle(article).cursor` 一直是 `auto`——指针样式来自按钮的 `::after` 热区。
   这一轮改用 `document.elementFromPoint(卡中心)`，同时记「命中的是不是那颗 `.vq-card-open` 按钮」
   （`stretchedOpen`）。按元素自己的 cursor 判，会把所有整卡可点的卡片判成「不可点」。
2. **要量「点卡片正文」，不是「点按钮」**。点按钮只证明按钮好用，证明不了整卡可点；
   正面证据是「点正文 → 路由变了 / 抽屉开了」。
3. **一次假阴性**：第一次跑的时候，模板抽屉里「用它做作品」量到 hover 与 press 全无、0 个写请求；
   用同一份脚本重跑就恢复正常（有 hover、有 press、1 个 `/api/projects` 写请求）。
   那是取样时机（抽屉还在展开、按钮位置已移动）造成的假阴性，不是缺陷——**所以这一项不写进结论**。
   另有一条门禁上的坑：新增 CSS 规则如果插在某条基础规则之前，`firstRule` 扫描（「桌面基样式一个像素没动」）
   会读到新规则而变红；`.template-card .template-adapt` 那条因此挪到 `.template-adapt--parse:disabled` 之后，声明一个字没改。

## 门禁与发布

新增 [test/card-affordance.test.mjs](../test/card-affordance.test.mjs)：每张会抬起的卡片必须有真入口（按文件内数量比，删掉其中一颗就红）、
不可点的卡片不许抬起、热区的三条 CSS 前提（铺满 / 按下不位移 / 按钮自己不许定位 / 宿主卡片必须 `position: relative`），
外加 7 组反证；[test/promo-undo.test.mjs](../test/promo-undo.test.mjs) 随重构改成盯着共用层，并加了一条「CTA 没挂 `.vq-card-open` 就红」。
