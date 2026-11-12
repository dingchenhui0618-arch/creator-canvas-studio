# 评审对照纸跟着分享链接走（v0.9.9）

## 为什么做

v0.9.8 把评审说的问题框回了画面，但那张纸只有**有账号的人**能打开：作品页的「交付」菜单，
或者登录后访问 `/print/projects/<id>/review`。可这张纸最该看的人是甲方、剪辑、拍摄——
他们手上只有一条只读分享链接，没有账号。

这一轮把同一张纸挂到分享链接上：拿到链接的人点一下就打开，不用登录，画面也走那条
带 token 的帧图接口（`/media/frames` 是要登录的，分享页本来就拿不到）。

## 现在长什么样

分享页顶栏多了「评审对照」，评审块里也有一张横条；点开是新标签里的一张 A4 纸：

- 左图右文，框上的编号对到右边问题列表；纸脚写「框是评审当时给出的位置，不是人工复核」；
- 抬头只有 版本 / 评审版次 / 导出时间——**不印作品内部 id**，公开链接的白名单同样不给它；
- 顶栏的返回是「返回分享页」（`/#/share/project/<token>`），不是「返回作品」——
  没有登录态的人回作品页只会撞上登录页；
- 多一句来源说明：「来自只读分享链接：链接停用后这个地址会打不开，已经存下来的 PDF 不受影响」。

## 三个实现决定

1. **打印路由不在 /api 下**：`/print/share/project/<token>/review`，与作品页的
   `/print/projects/<id>/review` 同一套纸。地址会出现在打印对话框的页脚里，
   带 `/api` 既难看也容易被人当成接口调用。凭证就是分享 token 本身。
2. **画面按帧序号取，不按文件名拼地址**：评审正文里记的是 `frames/<模板>/<文件名>`，
   `shareFrameIndex()` 只在模板自己的帧记录里找同名文件、拿它的 `index`，
   再拼成 `/api/share/project/<token>/frame/<n>`。找不到就不画图（写「不在这个分享里」），
   绝不按文件名猜一个地址。纸上不会出现 `/media/frames`。
3. **一处渲染，两个入口**：挑评审的规则抽成 `reviewSheetSelection()`——每版最近一次、
   版本 0 折进 v1、最多 3 版；作品页、交付包、分享纸都调它，不会各印一套。
   分享版只多三个参数：返回地址与文案、来源说明、缺图文案。

顺手修了一个旧口径：底栏的「N 条带框」以前数的是**有坐标的问题**，不是**画出来的框**。
没有画面时框一个都画不出来，底栏却还说「5 条带框」。现在只数画出来的，
纸脚也改成「这次的问题带了框的位置，但画面不在这份产物里，框画不出来」。

## 实测（生产真实作品 prj_f38d68c6，8 镜 8 帧 2 次评审）

| 项目 | 结果 |
| --- | --- |
| 分享页 1440 | 8 镜、8 张帧图全部加载、无横向滚动（scrollWidth == clientWidth = 1430） |
| 分享页 390 | 顶栏只留「评审对照」（打印 / 打开 VisionQA 收起）、横条 308px、无横向滚动 |
| 分享纸 900 | 5 个框、5 条问题、画面 480×854 加载成功、876×933、无 `/media/frames`、无作品 id |
| 分享纸 PDF | Chrome 存 PDF **1 页**（325,212 B，打印高度 881px） |
| 分享纸 390 | scrollWidth == clientWidth = 390，图 260px，顶栏 86px |
| 不用登录 | 分享纸 **200**；同一时刻 `/print/projects/<id>/review` **401** |
| 链接失效 | 不存在的 token **404** 给一张「这条分享链接已经失效」的纸；停止分享后同一地址也 404 |
| 与作品页一致 | 作品页那份与分享那份都是 5 个框、同一句底栏 |

截图（都是生产页面、未登录打开）：

- [分享页（1440）](./screenshot-share-review-2026-11-12.png)
- [分享页（390）](./screenshot-share-review-mobile-2026-11-12.png)
- [分享纸（A4，5 个框）](./screenshot-share-review-paper-2026-11-12.png)

> 为了拍这三张图，在生产上给这条作品**临时开过**一次分享链接，截完就停了；
> 截图里的链接现在已经失效。生产数据没有被改动：作品 1 个、画布 7 张、评审 3 条。

## 边界

- 链接本身就是凭证：拿到链接的人能看到脚本、分镜、评审次数，以及这张写着问题与框的纸。
  分享面板的文案已经写明这一点，开链接的人知道自己发出去的是什么。
- 停止分享 → 分享页与对照纸同时 404；已经存下来的 PDF 不受影响（纸脚也这么写）。
- 评审记录全局上限 200 条，单条作品扫最近 50 条摘要来挑「每版最近一次」；
  更早的重评历史不在纸上，仍留在作品页的版本对照里。
- 一次评审最多印 8 条问题（模型上限 5、服务端兜到 6）；超过一页会整块换页，不把图与列表切开。
- 框是模型评审当时给出的位置，不是人工复核；模型判断本身可能偏主观
  （这条作品里「双手没捏住衣角」就是一条），纸只保证「评审当时这么说过」。

## 复验

```bash
# 本地：用生产那份评审做一份 fixture，强制登录，验证分享路由不需要登录
DATA_DIR=.tmp-qa/r80-data API_PORT=8788 VQ_REQUIRE_AUTH=1 node server/index.mjs
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:8788/print/share/project/<token>/review?tz=480'   # 200
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:8788/print/projects/<id>/review?tz=480'             # 401

# 生产（先临时开分享，再停）
curl -s -X POST -H "Cookie: vq_session=<token>" https://visionqa.wavisionai.cn/api/projects/<id>/share
curl -s -o /dev/null -w '%{http_code}\n' 'https://visionqa.wavisionai.cn/print/share/project/<share>/review'
curl -s -X DELETE -H "Cookie: vq_session=<token>" https://visionqa.wavisionai.cn/api/projects/<id>/share
```

## 动到的文件

- `server/routes/project-share.mjs`：打印路由、评审挑选、帧图地址
- `server/project-share.mjs`：`shareFrameIndex()`
- `server/project-review-sheet.mjs`：`reviewSheetSelection()`；`backHref / backLabel / originNote / missingText`；
  底栏只数画出来的框
- `server/project-deliverable-html.mjs`：`printToolbar` 支持自定义返回地址与文案
- `server/routes/projects.mjs`：作品页那份改用 `reviewSheetSelection`
- `server/project-deliverable.mjs`：「只读分享」那行说清链接里有什么
- `src/api/projects.ts`、`src/pages/ProjectSharePage.tsx`、`src/styles/project-share.css`、
  `src/pages/ProjectPage.tsx`（分享面板文案）
- 测试：`test/project-share-review-print.test.mjs`（新）、`test/project-review-sheet.test.mjs`、`test/project-share.test.mjs`
