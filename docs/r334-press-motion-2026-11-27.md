# r334 · 按下反馈的「过渡」那一半：还在硬切的 32 处补上 transition（v0.9.306）

> 2026-11-27 · 结论先行：r333 把「按下去有没有变化」清零之后（136 颗按钮 · 无反馈候选 22 → 0），
> 还剩另一半没量过——**有变化不等于变化走过渡**。同一个巡检加上一行读数（computed 的
> transition-property / -duration，元素与 ::after 各一份）之后，v0.9.304 的线上产物上量到
> **32 颗按钮「按下有反馈、但是硬切」**（浏览器给的默认值是 `transition-property: all` / `duration: 0s`，
> 搜索那一格按下拿到的焦点环、五颗只有目标值的按钮、卡上那层压暗都落在这一档）。
> 这一轮补上 6 处 transition + 1 处焦点环，同一份脚本、同样 10 趟再量：**硬切 0**。

## 一、为什么「有反馈」还不够

按下反馈有两种做法，观感差一档：

| | 写法 | 观感 |
| --- | --- | --- |
| 硬切 | 只写 `:active` 里的目标值，没有 transition | 按下去「啪」一下到位，松手又「啪」一下弹回 |
| 过渡 | 同一批属性写进 `transition` | 顺滑加深、顺滑回来，和全站 `.vq-button` 一套手感 |

浏览器不会替你把这件事办对：`getComputedStyle(el).transitionProperty` 的**默认值就是 `all`**，
`transitionDuration` 是 `0s`——所以「看着像声明了过渡」和「真的会动」是两回事，必须把 duration 一起读。
量具这一轮加的判据就两条：**这条属性在不在 transition-property 里**、**它对应的 duration 是不是 0**。
不拿「按下两帧的读数等不等于终值」当判据（那只能说明过渡很短），也不拿 settledRescued 反过来用
（过渡没走完 ≠ 硬切，那是采样抖动的口径）。

## 二、这一轮补的七处

| # | 文件 | 家族 | 会被按出的变化 | 改法 |
| --- | --- | --- | --- | --- |
| 1 | `src/styles/motion.css` | `.vq-card-open::after`（整卡可点的卡：运营位 CTA、四张能力卡、模板卡） | `::after` 的 background-color | 给伪元素自己补 `transition`——**伪元素不继承元素的 transition**，元素那条是 tokens.css 给的，罩不到它 |
| 2 | `src/styles/shell.css` | `.vq-link`（工作台各段的「全部 …」「上手指引」等行内链接） | background / color | r332 定的「只压底不位移」，补上要变的两条 |
| 3 | `src/styles/shell.css` | `.vq-search` / `.vq-search--trigger`（顶栏搜索那一格） | box-shadow（按下先拿到焦点，2px 焦点环出现） | 这一格**没有自己的 :active 规则**，按下的反馈全来自 `:focus-within` 的环；焦点环、描边、底色一起补 |
| 4 | `src/styles/agents.css` | `.agx-surface-switch button`、`.agx-page .agx-capsule-trigger`、`.qc-new`、`.qc-tool` | background-color / border-color / color | r332 补的按下配色只有目标值，基类都没有 transition；四颗合成一条补上 |
| 5 | `src/styles/agents.css` | `.vq-content .agx-page .agx-tabs button`（对话预设页的分类页签） | background-color（原规则已给 color 0.15s） | 补在它自己的基类 `.agx-tabs button` 上，color 的 0.15s 保持不动 |
| 6 | `src/styles/overview.css` | `.ov-cap-action`（工作台能力卡上的纯文字按钮） | border-radius（按下从直角变 --radius-xs） | r333 已经补了底色，圆角是同一拍里"跳"出来的那一个，一起过渡 |
| 7 | `src/styles/review.css` | `.review-candidate`（视觉评审的候选卡） | transform（按下 1px） | 原本只有 border-color / background 在过渡表里 |

七处里有 5 处落在巡检那 10 趟覆盖的屏上（1/2/3/4/5），第 6 处只对「before 那版还是无反馈候选」的两颗按钮生效
（它们不进硬切统计），第 7 处在视觉评审页——**那一屏不在 10 趟里**，由静态门禁兜底。

## 三、证据：同一份脚本、同样 10 趟、两份产物

| | 产物 | 有反馈 | 无反馈候选 | 禁用 | **硬切** | 采样抖动单列 | 写请求 | 上游 | 异常 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| before | 0.9.304 / `index-CDUNYuqb.js`（**从 /opt/visionqa/dist 取回的线上原件**） | 105 | 22 | 9 | **32** | 1 | 2 | 0 | 0 |
| after | 0.9.306 / `index-BgRdMhjN.js` | 123 | 4 | 9 | **0** | 4 | 2 | 0 | 0 |

「硬切」这个判定是这一轮新加的读数，所以 before 也必须用**同一版量具**量：before 用的是线上 0.9.304 的原件
（不是本地重编——r333 量过，同一提交在不同目录重编出来的入口哈希与线上不一致，只有线上那份能当产物证据）。

逐趟（量了 / 有反馈 / 候选）：

| 趟 | before | after |
| --- | --- | --- |
| shell | 18 / 18 / 0 | 18 / 18 / 0 |
| overview | 24 / 20 / 4 | 24 / 22 / 2 |
| overview-cap | 5 / 3 / 2 | 5 / 4 / 1 |
| admin-promos | 11 / 7 / 0 | 11 / 7 / 0 |
| templates | 9 / 4 / 5 | 9 / 9 / 0 |
| templates-drawer | 10 / 9 / 1 | 10 / 10 / 0 |
| settings | 17 / 15 / 0 | 17 / 15 / 0 |
| projects | 12 / 2 / 10 | 12 / 12 / 0 |
| agents | 11 / 9 / 0 | 11 / 8 / 1 |
| agents-presets | 19 / 18 / 0 | 19 / 18 / 0 |

那 32 行落在 23 个家族里（按条数）：`.vq-card-open::after` 9（运营位 CTA 2 + 能力卡 6 + 模板卡 1）、
`.vq-link` 6、`.agx-tabs` 5、`.agx-surface-switch` 4（底色）/ 2（描边）/ 2（字色）、
`.agx-capsule-trigger` 3、`.qc-tool` 3（含 attach）、`.qc-new` 1（底色）+ 1（描边）、`.vq-search--trigger` 1（焦点环）。

### 43 条硬切属性，after 里 39 条量到「正在动」

| 分类 | 条数 | 例子 |
| --- | --- | --- |
| 两帧 ≠ 终值（在动） | **39** | `.vq-card-open::after` 两帧 `rgba(17,17,17,0.03)`、200ms 后 `rgba(17,17,17,0.06)`；搜索格的焦点环两帧 `0.03 0 0 0 1.10px`、终值 `0.06 0 0 0 2px` |
| 两帧 = 终值（仍然是硬切） | **0** | — |
| 两帧没读到变化（采样抖动） | 4 | 落在下面那 4 颗候选上，它们的终值那一拍全部有变化 |

同一批属性在 **before** 那一份里是另一种读数：43 条**全部**「两帧 = 终值」——真的一下到位。
两份产物、同一批属性，读数正好相反。

### after 的 4 颗「候选」是采样抖动，不是回归

r333 收尾时是 0 候选，这一轮 after 是 4 颗（overview 的运营位 CTA ×2、能力卡上的纯文字按钮、智能体的「新对话」），
而且 4 颗的 `changedSettledVsHover` 全都有变化（`settledRescued` = 4）。
给按下反馈加上过渡之后，两帧那一拍**有时会落在过渡的起点**（读到的值与悬停一模一样）——r333 记的是反面
（落在中间值）。判定口径没动（仍按两帧，与 r331–r333 的数字可比），这些行照旧单列成采样抖动；before 那份也有 1 颗。

### 静态截图看不见 120ms：这一轮没有对比图，是量出来的

`--shots all` 在按下那一刻给每一颗都截了图（元素矩形 + 8px）。把同一个元素在 before / after 两份产物里的
crop 逐像素比了 6 组：亮度差最大 **0.104/255**、最小 **0.0**——截图自己就要几十毫秒，等它到位时 120ms 的过渡已经走完。
所以这一轮的证据是**读数**（两帧 vs 终值），不是图；「静态图分不出硬切与 120ms 过渡」这件事本身也量过了。


## 四、两条自查

### 1. 静态门禁：`test/press-motion.test.mjs`（5 条 + 6 个反证）

把 `src/styles` 里每条 `:active` 规则过一遍，声明的每条属性都要能在同一份 CSS 里找到覆盖它的 transition。
三条讲究写进了文件头：

- **元素查元素那张表、`::after` 查伪元素那张表**——伪元素不继承元素的 transition（第 1 处修复就是踩这个）；
- 覆盖可以来自**类更少的同一条选择器**（`.works-action.is-danger.is-armed:active` 的过渡由 `.works-action` 那条提供，
  浏览器就是这么算的）；但来自**别的类**的（JSX 里同时挂了 `.vq-button`）静态看不出来，只能进白名单——
  白名单只留 2 条，每条写清原因，并且有用例检查「这条例外今天仍然量得到」（哪天它自己好了会红，提醒删掉而不是烂着）；
- **cursor 不是可过渡属性**，直接不算（写进 transition 也没用）。

另外单开一条焦点环用例（第 3 处修复）：按下会拿到焦点的元素，`:focus-within` / `:focus-visible` 上写的东西
同样是「按下会看到的变化」。反证是 6 个：把这一轮补的每一行删掉，检查必须变红。

### 2. 量具守卫没有恒真：顺带修好 r333 那条失灵的反证

新加的 `test/audit-press-motion.test.mjs`（3 条）钉住量具那几行读数（元素与 ::after 各一份过渡表、
`all` 也算覆盖、`declared || duration` 的判据、硬切进产物与报告），每条配一个反证。

**这一轮的注释把 r333 的一条反证弄失灵了，也一起修了**：`test/audit-press-after.test.mjs` 里那条
「把 AFTER_PROPS 里的背景那一项删掉，门禁必须变红」用的是整份源码 `includes('::after background-color')`，
而 r334 在量具里加的注释正好也写着这几个字——删掉数组那一项之后守卫照样绿。
现在它只在 `AFTER_PROPS` 那个数组块里找名字，反证又能真变红了。
（这就是 r332 记过的同一类坑：文本层守卫的锚点一旦在别处复现，守卫就变成恒真。）

## 五、门禁与发布

- `npm test` **2170 / 2170**（+9：`test/press-motion.test.mjs` 5 条 + 6 个反证、`test/audit-press-motion.test.mjs` 3 条、
  简写覆盖单测 1 条）；`npx tsc -b` 干净；`npx oxlint src server test scripts` 0 error / 30 warning（774 文件）；
  密钥扫描 1231 个文件无命中
- 入口 `index-BgRdMhjN.js`（873,536 B）里含 `0.9.306`。新增的过渡在产物 CSS 里逐条核过：
  `vq-search` / `review-candidate` / `vq-link` / `vq-card-open:after` / `ov-cap-action` 在入口 CSS，
  `agx-tabs` 在按需加载的 `agents-Buy09C_7.css`
- 发布标签 `20261127-0056-r334motion`；回滚点
  `/opt/visionqa/releases/20261126-165616-20261127-0056-r334motion.tar.gz`（元数据记 `entry: index-C44oKfL-.js`，即 0.9.305）
- 公网 `/api/version` **0.9.306**、`/api/health` ok（redfox / vision / llm 三项 true，templates 27）、新入口 200、
  上一版入口 `index-C44oKfL-.js` **404**、`visionqa` / `visionqa-internal` / `visionqa-demo` 三个服务 active

## 六、边界

- **只判「变化有没有走过渡」，不判「该不该有过渡」**：一个有过渡但时长长的按下，和这一层无关。
- **只量 1440×1000 的十趟**（与 r331–r333 同一份名单、同一批目标），视觉评审那一屏不在其中（见第 7 处）。
- 1px 位移与 120ms 的过渡**看不进静态截图**：crop 跟着元素矩形走，且截图的耗时本身就有几十毫秒。
  这一轮的证据按「按下两帧 vs 还按着等 200ms 的终值」两组读数给，不拿图当过渡的证明。
- 卡上那层 `.vq-card-open::after` 的压暗现在会走过渡，于是**按下两帧读到的底色是中间值**——
  r333 记的那句「补 transition 会让那 7 行两帧采样落进中间值」就是这件事，这一轮按预期发生了；
  判定仍按两帧（有没有变化），终值那拍照旧进产物。
