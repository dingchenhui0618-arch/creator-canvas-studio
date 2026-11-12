# 模板库能回答「这条我做过吗」：卡片写作品数，详情里逐条列出（v0.9.14）

上线：2026-11-12，生产 visionqa.wavisionai.cn，版本 0.9.14。

## 为什么做这个

模板库与作品是两组数据：模板库管「有什么可抄」，作品管「我在做哪条」。
结果就是打开一条模板时不知道**自己是不是已经用它做过作品**——
做了两条、三条的模板，在库里跟没动过的一样。

这一轮把两边连起来：卡片上写「几条作品在用」，详情里逐条列出是哪几条，点一行直接进那条作品。

顺带修掉一个一直存在的口径问题：卡片原来写「已复用 N 次」，那是**只增不减的计数器**
（每次点「用它做作品」+1，删掉作品也不回落）。生产这条模板是 **5 次复用、1 条作品在用**，
两个数字都对，但回答的是不同问题——「做过几次动作」和「现在还有几条作品绑着它」。

## 长什么样

- 模板库顶部汇总第三格从「累计复用 / 次」改成「作品在用 / 条」，数字是现算的；
- 卡片指标行在「几段脚本 · 几个分镜」后面多一格「1 条作品在用」（没被用过的模板不显示）；
- 详情抽屉最上面一块「用这条模板的作品」：一行一条，标题 + 第几版 + 在做 / 已交付，点一行进作品；
- 一块模板被很多作品用过时最多列 8 条，下面一句「还有 N 条没列出来，去作品列表看全部」；
- 没有作品用它，这一块不出现——空白模板的抽屉不多一块空壳。

## 三个实现决定

1. **用量现算，不用计数器**。`reuseCount` 是「点过几次用它做作品」，删作品不回滚，
   还会被复刻动作加进去（生产：5 次复用 vs 1 条作品在用）。作品数量从 `projects.json` 现算，
   归属沿用 `listProjects` 的同一套规则：谁能看这条作品，它才被算进那条模板的用量。
2. **计数放列表、明细放详情**。卡片只要一个数字（26 种模板一次拉完不重），
   是哪几条只在打开抽屉时取一次（一次只开一条模板，列表里不带 `projects` 数组）。
3. **明细放在指标行，不放卡片脚注**。第一版把「N 条作品在用」塞进脚注，
   长作者名（抖音 · 整理收纳小李）把脚注顶成两行，卡片比同排高一截；
   改到「几段脚本 · 几个分镜」那一排之后，脚注恢复一行，卡片高度与同排一致。

## 量到的

生产真实数据（26 条模板，其中「毛衣快速折叠收纳法」被 1 条作品用着，计数器是 5）：

| 读的地方 | 读数 |
| --- | --- |
| `/api/templates` | 26 条；`projectTotal: 1`；该条 `projectCount: 1`、`reuseCount: 5`；列表里没有 `projects` 数组 |
| `/api/templates/tpl_5323f485` | `projectCount: 1`，`projects: [{id: 'prj_f38d68c6', title: '毛衣折叠收纳法', status: 'active', version: 2, updatedAt: '…10:34:05Z'}]` |
| 模板库 1440 | 汇总「作品在用 1 条」；卡片 355×392px；指标行「8 段脚本 8 个分镜 1 条作品在用」；`scrollWidth == clientWidth` |
| 详情抽屉 1440 | 抽屉 580px，作品行 521×52px，小标题「1 条 · 点一行进作品」 |
| 详情抽屉 390 | 抽屉 390px，作品行 341×52px，`scrollWidth == clientWidth` |

## 边界

- **计的是「作品绑着这条模板」**，不是「用过几次」：一条作品开几版（v2、v3）仍只算 1 条。
- **只算当前账号能看到的作品**：管理员看全部，普通账号只看自己的。
- **模板被删掉的作品不计**：作品还在（模板字段清空），但没有模板可以算进用量。
- **删作品会回落**：这是和 `reuseCount` 最大的区别，也是这一轮想要的口径。
- **详情最多列 8 条**：再多就写「还有 N 条」，页面上不铺长列表。
- **不是「受欢迎程度」**：用量是账号自己的作品数，收藏、复用次数都不参与；公共模板的用量只算当前账号自己的作品。

## 复验命令

```powershell
# 列表：每条模板的 projectCount 与总用量
curl.exe -s -b cookies.txt https://visionqa.wavisionai.cn/api/templates
# 详情：用这条模板的作品（最多 8 条）
curl.exe -s -b cookies.txt https://visionqa.wavisionai.cn/api/templates/tpl_5323f485
# 测试：分组、回落、计数、上限
node --test test/template-usage.test.mjs
```

## 改到的文件

- `server/template-usage.mjs`（新）：`projectsByTemplate`（按模板分组、最近的排前）、`withProjectCount`、`totalProjectCount`、`templateWorksView`（总数 + 最多 8 条）。
- `server/index.mjs`：`/api/templates` 每项挂 `projectCount` 与 `projectTotal`；`/api/templates/:id` 多给 `projectCount` 与 `projects`。
- `src/domain/radar.ts`：`ReplicaTemplate.projectCount / projects`、`TemplateProjectRef`、`TemplateList.projectTotal`。
- `src/pages/TemplateLibraryPage.tsx`：汇总格改「作品在用」、卡片指标行加一格、详情抽屉加「用这条模板的作品」一块与「还有 N 条」。
- `src/styles/radar.css`：`.drawer-works` / `.drawer-work`、`.template-uses`、`.drawer-works-more`、脚注单行省略。
- `src/App.css`：打印模板时隐藏「用这条模板的作品」（纸上是模板本身，不是我的作品清单）。
- `test/template-usage.test.mjs`（新，6 条）：分组与排序、归属过滤、计数与回落、详情上限。

## 生产数据

这一轮只读：没有新建、删除或修改任何模板与作品，也没有开关分享。
唯一的变化是同一版本重发了三次（`v0.9.14` → `v0.9.14b` → `v0.9.14c` → 最终 `v0.9.14d`），
前两次是拍图时发现脚注换行与用量位置不对，改完重发；最终 release 是 `20261112-162919-v0.9.14d.tar.gz`。
