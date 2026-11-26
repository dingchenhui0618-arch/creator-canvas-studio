# 发版记录：v0.9.294（r322 充值页运营位 + 关掉时的动效），2026-11-26

结论：r322 已上生产。当前生产 `0.9.294`，入口 `index-R7L-Ypxl.js`，health ok templates 27，
两个服务 active，一次发布成功。本轮把「广告模块」里一处**静默失效**补上（充值页的运营位配了也永远不显示），
并把关掉一条运营位的手感从「一按就没了、下面跳一格」改成「先塌下去、淡出、再移除」。
本轮 **0 次上游调用、0 积分**。

## 这一版改了什么

| 位置 | 改动 |
| --- | --- |
| `src/pages/RechargePage.tsx` | 挂上 `<PromoSlot placement="recharge" />`（位置白名单里从 r320 起就有 recharge，但**没有任何页面挂载点**） |
| `server/promos.mjs` | 默认运营位补一条 `recharge`：小标签「积分能换什么」、标题「10 积分复刻一条片子」、正文写清复刻 10 / 出图 5 / 4 秒视频 15、失败原路退回、按钮「去复刻」 |
| `src/components/PromoSlot.tsx` | 关掉一条时先塌下去再移除（内联 `max-height` 钉住当时高度 → 下一帧收到 0 → `transitionend` 或 420ms 兜底才写进「关掉过」）；进场复用 `motion.css` 的 `.vq-stagger`；连点两条时前一条立刻收尾，不让第二次点击落空 |
| `src/styles/promos.css` | `.vq-promo.is-leaving` 的塌陷与淡出；间距从 grid 的 `gap` 挪到「不是最后一条」的下边距上 |
| `test/promos.test.mjs` | 新增护栏：白名单里的每个位置**必须**有页面挂载、也必须**有默认内容** |

## 为什么「配了却看不见」值得单独修

`PROMO_PLACEMENTS` 从 r320 起就是 `['overview', 'templates', 'recharge']`，后台「运营位」卡的下拉里也有
「充值 / 积分」，服务端校验也放行——但**没有一个页面挂** `<PromoSlot placement="recharge">`。
管理员在后台把一条运营位配到充值页、保存、刷新、再刷新：什么都不会出现，也没有任何报错，
从界面上根本看不出哪里错了。这类「声明了但没接线」的洞不会自己暴露，只会安静地让功能作废。

所以这一版除了补挂载点，还把这件事写成护栏测试：

- 遍历 `src` 下所有 `.ts/.tsx`，白名单里的每个 `placement` 都必须能找到 `<PromoSlot placement="…"`；
- 每个 `placement` 至少要有一条默认内容——生产上后台从没存过（`source=default`），没有默认条目
  这个槽上线就是空的，等于没做。

护栏不是摆设：拿一个没挂载的位置（例如 `settings`）跑同一段判断，结果是 `false`，断言会红。

## 关闭动效：三处都是「实测出来」才改对的

第一版只做了「内联 max-height 从当前高度收到 0」，看着像在动，真去量才发现三处不对
（都是真渲染时按 25ms 一档采样量出来的）：

1. **塌不到 0**：`max-height` 的计算值已经收到 0.03px，`offsetHeight` 却卡在 **34px** ——
   正好是上下内边距 16+16 与描边 1+1。border-box 并没有把这层「地板」一起收掉，
   于是卡片先塌到 34px、挂着空壳约 200ms，等被移除时最后那 34px 一次性跳没。
   改法：内边距与描边也一起过渡到 0。
2. **「淡出」其实没发生**：transition 里写了 `opacity`，但没有任何规则给出目标值，
   实测整段 computed `opacity` 恒为 1；看到的「变淡」只是 `max-height` 把文字裁掉了。
   改法：补上 `opacity: 0`。
3. **移除时下面还会跳 8px**：间距本来是容器的 `grid gap`，卡片收不掉它——即使高度收到 0，
   容器仍留 8px 空档，移除那一刻下面那条跳最后 8px。
   改法：把间距挪到 `.vq-promo:not(:last-child)` 的下边距上，并在 `is-leaving` 里一起收到 0
   （最后一条不带下边距，容器底部与原来一致）。

### 本地（同一位置两条，1440）

```
塌陷曲线（点后 ms:高度）：26:107 51:91 75:78 101:52 125:23 150:15 175:7 201:5 226:2 250:2 275:2 301:0 324:0 351:gone
下面那条的位置：378.58（点前）→ 263.19（324ms，还在 DOM）→ 263.19（351ms，已移除）= 差 0.00px；700ms 仍是 263.19
中间帧：点前 107px → 截图前 92px（86% · opacity 0.3577）→ 截图后 2px（2% · opacity 0）
```

- 高度一路收到 **0** 才移除（不再有 34px 空壳）；
- 撤下期间 `opacity` 从 1 走到 **0**（真淡出，不是被裁）；
- 移除前后下面那条 **0.00px 不动**；整个收拢过程它平滑上移 115.39px（107 卡片 + 8 间距 + 亚像素）；
- 700ms 后卡片不在 DOM，`localStorage.vq_promos_dismissed` 里留下它的 id，刷新后不回来。

**反证（证明这条断言不是空转）**：在页面上把改动前的 `.vq-promos{gap:var(--space-2)}` 注回去
（只注入页面样式，不碰仓库），同一个探针量到移除那一刻跳 **8.01px** —— 真回到旧写法断言会红。

### 生产（这一屏只有默认那一条，1440）

生产上同一个探针量到（`scripts/shot-r322-prod.mjs`，只发 GET、不改任何生产数据）：

```
卡片 107px → 0px · opacity 最小 0
下面那张卡（余额卡）整段上移 107.39px，收拢过程中最大偏离「由卡片高度解释的位置」0.85px
移除那一刻的最后一跳 40.00px（= 运营位区外边距 24 + 页面栅格间距 16）
```

脱敏后的曲线（`ms:高度/透明度`）：`26:99/0.61 51:77/0.31 75:33/0.10 100:22/0.06 124:14/0.03 150:7/0.006 176:3 199:2 226:2 250:2 276:0 300:0 324:0 351:gone`

## 真渲染（临时实例 + 真账号 + 真 SQLite + 真渲染，0 次上游调用、0 积分）

脚本 `scripts/shot-r322.mjs`（r315 起同一套做法）。四张图都由真渲染产出：

| 截图 | 说明 |
| --- | --- |
| [docs/r322-recharge-default-1440.png](r322-recharge-default-1440.png) | **生产现状**：临时实例一次 `PUT` 都没发，`GET /api/admin/promos` → `source=default`、数据目录里没有 `promos.json`；充值页显示的就是默认内容里 `placement=recharge` 的那条（标题/按钮/正文取响应字符串，脚本里没有写死） |
| [docs/r322-recharge-promo-1440.png](r322-recharge-promo-1440.png) | 管理员经真接口写入 5 条后的充值页：同位置两条（权重 90 / 70），`internal` 那条与 `templates` 那条都不在页面上 |
| [docs/r322-promo-dismiss-mid-1440.png](r322-promo-dismiss-mid-1440.png) | 关闭中间帧：点后约 199ms，卡片仍在 DOM、`is-leaving`、高度 92px、`opacity` 0.3577（正在淡出） |
| [docs/r322-recharge-promo-390.png](r322-recharge-promo-390.png) | 390：两条竖排、按钮占满一行、关闭按钮 28×28 且右边缘 357 < 390，`scrollWidth 390 === innerWidth 390` |

「页面上的字确实来自接口」是这样证明的：脚本把 `PUT /api/admin/promos` 的**响应**建成 id→title 表，
之后每一处 DOM 断言都拿响应值去比；同一实例给普通账号的 `/api/promos` 是 4 条（`internal` 由服务端滤掉），
与写入的 5 条正好差 1；再对照默认态那张（不写入时显示默认内容），两边一差就能说明是接口给的，不是前端恰好写着。

### 生产真渲染（`scripts/shot-r322-prod.mjs`）

生产侧临时签一个管理员会话（令牌只写 0600 文件、scp 回本机、脚本只读不打印、拍完撤销），
在公网 `https://visionqa.wavisionai.cn` 上真渲染：

| 断言 | 生产上的实际值 |
| --- | --- |
| `GET /api/promos` | 5 条，`placement=recharge` 恰好 1 条：`recharge-what-credits-buy`「10 积分复刻一条片子」/「去复刻」 |
| 页面上的那条 | 标题、正文、按钮、小标签与响应逐字一致；`count=1`；`vq-stagger` 在；溢出 0 |
| 侧栏版本 | `v0.9.294`（图已在 r323 重拍为 0.9.295 + 身份行遮盖，见下） |
| 关闭动效 | 见上一节（107→0、opacity→0、0.85px 跟随、最后一跳 40.00px） |
| 页面报错 | none |

[docs/r322-prod-recharge-default-1440.png](r322-prod-recharge-default-1440.png)（1440×1000）——
**这是生产上用户现在看到的充值页**。收尾：`user_agent LIKE '%r322-prod-shot%'` 的会话 before 1 / removed 1 / after 0，
令牌与用户文件都已删。

> r323 里重拍过这张图：原图侧栏底部带着手机号（后台与用户页的侧栏都会显示登录名，而线上账号的登录名就是手机号），
> 仓库是公开的，所以现在拍照前会把 DOM 里的 11 位手机号与邮箱换成占位符。重拍用的是 0.9.295：
> 用户侧运营位代码在 0.9.294 → 0.9.295 之间一字未改（只动了后台编辑卡、`promosDirty`、console.css 与版本号），
> 关闭动效重测 107px → 0px、`opacity` 最小 0、下面那张卡最大偏离 0.63px、移除那一刻 40.00px——与上面记录一致。

## 门禁

| 门禁 | 结果 |
| --- | --- |
| `npm test` | 2106 / 2106 通过（新增 1 条护栏），0 fail / 0 skip |
| `npx tsc -b` | 干净 |
| `npx oxlint src server test scripts` | 0 error / 30 warning（744 个文件） |
| `npm run scan:secrets` | 1189 个文件，没命中 |
| `npm run build` | 入口 `index-R7L-Ypxl.js`（867,380 B）、CSS `index-Dwks99VY.css` |
| CI | run `45806852527` success（Node 24），提交 `2c887c9` 已推 `master` |

产物里能搜到的：`placement:\`recharge\`` 1 处、`is-leaving` 1 处、`vq-stagger` 3 处；
**默认运营位的文案在 JS 里搜不到**（「10 积分复刻一条片子」命中 0 处）——内容在服务端 `server/promos.mjs`，
前端只是渲染，这正好说明它不靠发版也能改。

## 发版

| 项 | 值 |
| --- | --- |
| 当前生产 | `0.9.294` · 入口 `index-R7L-Ypxl.js` 867,380 B |
| 回滚点 | `/opt/visionqa/releases/20261126-105516-20261126-1920-r322promo.tar.gz`（`--to 1` 回 0.9.293 / r321） |
| 健康 | `/api/health` ok，redfox / vision / llm 全 true，templates 27 |
| 公网 | `/api/version` 200 `0.9.294`（8799 与公网一致）；新入口 200；上一版入口 `index-C4p7ot7V.js` 404；匿名 `/api/promos` 401（两处都是） |
| 部署产物 | `/opt/visionqa/server/promos.mjs` 里搜到 `recharge-what-credits-buy` 1 处 |
| 服务 | visionqa / visionqa-internal 都是 active |

回滚：`bash /opt/visionqa/ops/rollback.sh --to 1` 回 v0.9.293（r321）。

## 边界

- **关掉「这一屏最后一条」时会有一个 40px 的收尾**（生产上现在就是这种情形：充值页只有默认那一条）。
  卡片本身是平滑收拢+淡出的（107→0、opacity→0），但运营位区变成空区块后要被移除：
  它自己的外边距 24px 与页面栅格间距 16px 是**结构性的**，一起消失就是 40px。
  要让这 40px 也平滑，只能让空区块继续占位——代价是页面上永远留 16px 空隙（换一屏、刷新后都在），
  比一次干脆的重排更像 bug，所以**这一版明确不做**。同一位置还有下一条时是 0.00px（本地实测），
  只有「关掉最后一条」才会遇到这 40px。生产脚本把这 40px 写成断言（`|最后一跳 - 40| <= 2`），
  哪天做平滑了它会红，正好提醒回来改这段文档。
- 生产运营位**仍是默认内容**（`source=default`）：后台「保存」这条路只有本地证据（本地是用真接口
  `PUT /api/admin/promos` 写入后渲染的），生产后台这一轮没有真存过。
- 动效只在 Chromium 系（本地与生产都是无头 Chrome）与 390 / 1440 两个宽度上量过；Safari / Firefox 未验。
- 一屏超过两条（把 `max` 调大）的情况没有单独取证。
