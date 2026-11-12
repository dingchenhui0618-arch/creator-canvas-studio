# B/C/D 缺口修复记录（2026-11-12 起）

目标：按 [ui-polish-and-gap-audit-2026-11-12.md](ui-polish-and-gap-audit-2026-11-12.md) 审计出的 B（产品）、C（工程）、D（合规）三类缺口顺序补齐并上线生产。
明确不做：A 类外部输入（ICP 备案号、客服邮箱、支付定价、告警 webhook、备份异地）、真实模型校验（出图出视频 / 多供应商回退 / 权重比例）、单机扩容、团队协作成员邀请（依赖邮件验证）。

| 编号 | 条目 | 状态 |
| --- | --- | --- |
| B1 | 模板导出：Markdown 文件 + 打印 / 存 PDF | 已上线 2026-11-12 |
| B2 | 雷达检索历史与关键词收藏 | 已上线 2026-11-12 |
| B3 | 模板回收站（软删除 / 恢复 / 彻底删除） | 已上线 2026-11-12 |
| B4 | 模板编辑版本历史（快照 / 回看 / 回滚） | 已上线 2026-11-12 |
| B5 | 模板只读分享链接 | 已上线 2026-11-12 |
| C1 | GitHub Actions CI（类型检查 / 构建 / 代码检查 / 单测） | 已上线 2026-11-12 |
| C2 | 回归测试入库、可离线跑 | 已完成 2026-11-12 |
| C3 | 前端异常上报 + 后台可见 | 已上线 2026-11-12 |
| C4 | 日志保留策略（轮转 + 保留天数） | 待做 |
| C5 | 部署回滚（保留多个 release + 一键回滚） | 待做 |
| D1 | 注册「已读条款」留痕 | 待做 |
| D2 | TOTP 双因素 | 待做 |
| D3 | 自助数据导出 + 注销账号 | 待做 |
| D4 | 公共模板来源署名 + 侵权举报通道 | 待做 |
| D5 | UGC 举报后台审核队列 | 待做 |

---

## B1 模板导出：Markdown + 打印 / 存 PDF

### 问题
模板详情只能在工作台里看：编导要交给剪辑、贴进飞书、归档给客户时没有任何出口，全站唯一能导出的是后台审计页的 CSV。这是「拆完的剧本走不出系统」的最后一公里。

### 做法
1. 纯函数导出模块 src/lib/templateExport.ts：把模板转成 Markdown（互动数据表、开头钩子、时长对账、脚本结构表、分镜逐镜清单、爆款分析、来源与用途声明），文件名带标题与日期，非法字符替换为 -。
2. 抽屉底部新增「导出」区：下载 Markdown / 打印或存 PDF 两个按钮，附一句说明（Markdown 给协作，打印给纸质归档）。
3. 打印：抽屉改为 React portal 直挂 document.body，打印时只留抽屉这一层（body 下其它节点 display:none），白底、深墨、A4 页边距 14mm；屏幕上的淡紫底色标签改成细线框，按钮与页脚不上纸。
4. 按钮在未解析的模板上也保留：只有链接与互动数据的条目同样能导出，内容自动降级为「还没解析」说明。

### 验证（生产 https://visionqa.wavisionai.cn，入口 index-C0wexkdI.js）
- 抽屉里点「下载 Markdown」真的落盘：VisionQA-兔兔那么可爱…真香-20261112.md，2390 字节，7 个二级标题（互动数据 / 开头钩子 / 时长对账 / 脚本结构 / 分镜表 / 爆款分析 / 来源与用途）。
- 打印媒体下 .template-drawer 成为 body 直接子节点，根节点 display:none，页脚与导出区 display:none，底色 rgb(255,255,255)。
- 794 宽（A4 内容宽）量：scrollWidth 794 = innerWidth，抽屉右边界 794，各分节标题右边界都在 794 以内，无横向溢出。
- Chrome printToPDF：3 页、634843 字节，不是空白一页。
- 未解析模板与画布工作流模板走各自的降级分支（节点清单 / 链接与互动数据）。

### 产物
![模板抽屉的导出区](screenshot-template-export-2026-11-12.png)

![打印版式：A4 纯白稿，只留抽屉内容](screenshot-template-print-2026-11-12.png)

截图：docs/screenshot-template-export-2026-11-12.png、docs/screenshot-template-print-2026-11-12.png。样例 Markdown 见 .tmp-qa/audit/export-sample.md（临时目录，未入库）。

---

## B2 雷达检索历史与关键词收藏

### 问题
雷达每次检索花 2 积分，但条件不落任何地方：关掉页面就没了，想回看上次搜过的关键词只能重打一遍、再花一次钱。审计里「每次重搜花 2 积分」说的就是这件事。

### 做法
1. 服务端 server/search-history.mjs：按账号记「平台 + 关键词 + 时间档 + 排序 + 结果条数 + 时间」。同一个人用完全相同的条件再搜，只更新时间不新增；每账号最多留 40 条没收藏的记录，收藏的永不被裁剪。
2. 三个接口：GET /api/search/history（收藏在前、其余按时间倒序，最多 14 条）、POST /api/search/history/:id/favorite（切换收藏）、DELETE /api/search/history（清空，但保留收藏）。检索成功时只在第 1 页落一条，翻页不重复记——否则一页一条会把历史刷满。
3. 界面：工具栏下方一条「检索历史」，每条是一枚 chip（平台 · 关键词 · 条数）+ 星标 + 右侧「清空」。点 chip 只把条件填回表单并提示「已填回……确认后点检索」，**不自动检索**：自动重搜等于替用户扣 2 积分。

### 验证（生产，入口 index-BO7gWWNc.js）
- 历史为空时这一条不显示，首屏只有工具栏与空态引导。
- 真检索一次「猫咪」：74 条已加载 / 共 127.2 万条，历史条随即出现「全部 猫咪 127.2万 条」，0 JS 异常。
- 点星 → class 变 is-favorite、图标变金；整页 reload 后仍在，且仍是收藏态。
- 服务端落盘：{ platform: all, keyword: 猫咪, range: "", sort: likes, total: 1272310, favorite: true }，按 userId 隔离。
- 清空语义：有收藏时 DELETE 返回 removed 0、记录还在；取消收藏后再 DELETE 返回 removed 1、列表为空。
- 390 宽：scrollWidth 390 = 视口，历史 chip 换行不撑破页面。

### 产物
![检索历史：收藏的关键词带星、点一下填回条件](screenshot-radar-history-2026-11-12.png)

---

## B3 模板回收站

### 问题
删除是硬删：一条解析过的模板要花 10 积分才拆得出来，点错一次就永久消失，连抽好的帧一起清掉。列表里没有任何「找回」的可能。

### 做法
1. 删除改成软删除：条目打上 deletedAt / deletedBy，列表与统计都过滤掉回收站里的条目（模板总数、已解析、待解析、工作流计数同步不再算它们）。
2. 三个接口：GET /api/templates/trash（按删除时间倒序，附 days=30）、POST /api/templates/:id/restore、POST /api/templates/:id/purge。彻底删除才清 frames 目录。
3. 30 天自动清空不靠定时任务：列回收站时顺手把过期条目连同抽帧一起清掉，所以只要有人打开就生效。
4. 顺手补了一个越权口子：DELETE 之前先用 getTemplate(id, user) 校验归属，别的账号的模板不能删（原来只按 id 删）。
5. 界面：模板库页头加「回收站」按钮，弹窗列出条目（标题、平台 · 类型、删于时间、还剩几天），每条「恢复」「彻底删除」，彻底删除要二次确认；删模板的提示改成「已移到回收站，30 天内可以恢复」。

### 验证（生产，入口 index-CTNNSt46.js）
- 用两条自测条目跑完整链路：创建 → 删除返回 {ok, trashed:true} → 列表里查不到（total 仍是 25）→ 回收站 2 条、days=30。
- 弹窗实测：2 行，文案「删除的模板在这里留 30 天……不能撤销」，每行「恢复 / 彻底删除」。
- 点「彻底删除」先出现「彻底删除后不能恢复 + 确认删除 / 取消」，点取消不改状态。
- 点「恢复」：行消失，toast「已恢复「回收站自测 B」，回到模板库」，接口列表随即能查到这条。
- 彻底删除后回收站清零、列表清零；全程 0 JS 异常。自测数据已全部清掉，没有留在库里。

### 产物
![模板回收站：30 天内可恢复，彻底删除要二次确认](screenshot-template-trash-2026-11-12.png)

---

## B4 模板编辑版本历史

### 问题
后台改模板（标题 / 类型 / 标签 / 原链接）是就地覆盖：改错了只能凭记忆改回去，没有「上一版长什么样」。模板是花 10 积分解析出来的资产，编辑却不留痕。

### 做法
1. updateTemplate 在应用补丁前留一版快照（标题、类型、标签、原链接 + 时间 + 操作者），最多留 10 版；**只有受管字段真的变了才留**，保存一次没改内容不会在历史里多一条。
2. 两个接口：GET /api/templates/:id/versions、POST /api/templates/:id/versions/:versionId/restore。回滚走的是同一条 updateTemplate，所以回滚本身也会留一版——回滚错了还能再退回。
3. 后台模板治理的编辑卡里加「历史版本」：展开列出每一版的时间与「标题 · 类型」，每条一个「回滚到这一版」，并说明回滚会先把当前内容存成一版。

### 验证（生产，入口 index-CMMKHX9z.js）
- 建一条自测模板「第一版」→ 改「第二版」（历史 1 版）→ 改「第三版」（历史 2 版），列表为 [第二版, 第一版]——留的是「改之前」的样子。
- 回滚到最早那版：标题回到「第一版」，历史变 3 版（回滚前的第三版也存了一版）。
- 后台界面实测：搜「版本自测」→ 编辑 → 历史版本，3 行、时间 + 标题·类型 + 回滚按钮，提示文案「每次保存前留一版（最多 10 版）」。
- 全程 0 JS 异常；自测条目已删除并彻底清理，库里没留垃圾。

### 产物
![后台模板治理：历史版本与一键回滚](screenshot-template-versions-2026-11-12.png)

---

## B5 模板只读分享链接

### 问题
拆解结果只能给「有账号的人」看：编导要把脚本分镜发给剪辑、客户或甲方时，只能截图，或者让对方注册一个账号。审计里「分享」这一项是空的。

### 做法
1. 链接就是凭证：POST /api/templates/:id/share 生成 18 字节随机 token（base64url，24 字符）存在模板记录上；DELETE 同一路径把 token 清掉，旧链接当场失效；重新开启换一个新 token，不复用旧地址。
2. 公开读接口进 PUBLIC_API：GET /api/share/:token 返回白名单视图，帧图走 /api/share/:token/frame/:index、封面走 /api/share/:token/cover——/media/frames 与 /api/cover 都要登录，分享页不能借那两个口子。停止分享、进回收站或彻底删除之后，这三个地址一起 404。
3. 公开视图逐字段挑（publicTemplateView），不做「整条对象删几个 key」：ownerId、versions、deletedAt、shareToken、blueprint 这些内部字段不在白名单里，以后新加的内部字段也不会自动漏出去。
4. 前端新路由 #/share/:token：在 App 根部整屏渲染、不经过 RequireSession（否则打开就先跳登录页），单独拆包（SharePage 9.44 kB / gzip 3.38 kB）。页面是一张纸：品牌行 + 只读徽标、标题、类型/平台/作者/时长/分享日期、标签，然后是互动数据、开头钩子、脚本结构、分镜表（带帧图与时长对账）、爆款分析、来源；页脚写明「只读、不能改也不能套用」，并给「下载 Markdown」「打印」两个出口。只存链接的条目显示「还没解析」，画布工作流显示节点清单。
5. 模板抽屉里加「分享」区：没有链接时一个「生成只读链接」；有链接时只读输入框 + 复制 + 停止分享，附一句「拿到链接的人不用登录就能看，只能看不能改，停止分享后旧链接立即失效」。
6. 打印：App.css 的打印规则只保留抽屉，分享页在这里把 #root 放回来、隐藏工具栏，导出的就是这份文档本身。

### 验证（生产 https://visionqa.wavisionai.cn，入口 index-Lx5AM7-3.js）
- 真实模板「兔兔那么可爱…真香」（8 分镜 / 8 帧）开分享：token 24 字符；不带任何 cookie 请求 GET /api/share/<token> → 200，字段只有 id、kind、title、contentType、tags、platform、platformLabel、sourceUrl、author、publishedAt、stats、durationSec、hook、hookType、structure、storyboard、timing、analysis、frames、cover、video、reuseCount、flowNodes、sharedAt。
- 泄漏检查：ownerId / versions / blueprint / shareToken / deletedAt 五项全部 false。
- 匿名取帧图 GET /api/share/<token>/frame/0 → 200 image/jpeg 33317 字节。
- 匿名打开 #/share/<token>：h1「兔兔那么可爱…真香」，元信息「宠物日常 / 抖音 / 郡*乐宝 / 0:19 / 分享于 2026-11-12」，6 个分节、8 行分镜、8/8 帧图真的解码出来（naturalWidth > 0），页面上没有登录表单、没有侧栏。
- 390 宽：scrollWidth 390 = 视口，无横向溢出；1440 宽：正文 880px 居中（x=275，两侧各 275）。
- 只存链接的条目：分节只有「互动数据 / 还没解析 / 来源」，说明文案指向「由账号主人跑一次解析」。
- 停止分享：DELETE → 200；随后匿名 GET 同一地址 → 404 SHARE_NOT_FOUND；新开页面显示「这个分享链接已经失效」，没有登录框；模板记录里 shareToken 已清空。自测条目已删除并彻底清理，模板总数回到 25。
- 全程 0 未捕获异常（唯一一条 401 是匿名访问 /api/auth/me 的正常探针）。

### 已知边界
- /media/frames 与 /api/cover 本身不校验登录（历史实现只挡了 /api/*），所以抽帧图片按模板 id 可匿名猜取。分享页没有依赖这个口子，但它是既有状况，本次不动（改了会影响画布与其它服务的取图），记在这里待办。
- 已经打开的分享页在停止分享后仍显示已下发的内容（内容已经到浏览器了），重新加载即失效；要更强就得做短时签名 URL，本次不做。

### 产物
![模板只读分享页：不登录也能看脚本结构与分镜](screenshot-template-share-2026-11-12.png)

![模板抽屉的分享区：生成、复制、停止分享](screenshot-template-share-drawer-2026-11-12.png)
---

## C1 GitHub Actions CI

### 问题
仓库此前没有任何自动检查：类型、构建、代码检查、测试全靠上线前在本地手工跑。推错一行就到部署那一刻才发现，没有回退余地。

### 做法
1. .github/workflows/ci.yml：push 到 master 与所有 PR 都触发，concurrency 按 ref 取消同分支旧任务，超时 15 分钟。
2. 步骤顺序：checkout → setup-node 22（带 npm 缓存）→ npm ci --ignore-scripts → npx tsc -b → npm run lint → npm test → npm run build。任何一步非零，这个 run 就是红的。
3. npm ci 用 --ignore-scripts：ffmpeg-static / ffprobe-static 的 postinstall 会去 GitHub 下载二进制，CI 的静态检查与单测都用不到，跳过少一个失败面。
4. 不跑联网、不跑要花积分的东西：整套单测在临时 DATA_DIR 里跑，不碰生产数据。
5. checkout / setup-node 用 v7：v4 会触发 Node 20 弃用告警（被强制跑在 Node 24 上）。

### 验证
- 923bba1 首次运行：success；安装依赖 / 类型检查 / 代码检查 / 单元测试 / 构建 五个业务步骤全部 success。
- d87ea0d 升级 action 版本后再跑：success，全程 22 秒（03:16:19 → 03:16:41），注解里不再有 Node 20 弃用那一条。
- 剩下的是既有的 6 条 lint warning：oxlint 退出码 0，不挡合并，但都会打在 CI 注解里，改一处就少一条。

---

## C2 回归测试入库、可离线跑

### 问题
原来只有 scripts/test-*.mjs 这类脚本：要服务在跑、要配 Key、有的还会花积分（检索 2 分、评审 10 分）。没有一条能进 CI、能离线跑、能在回退时报警。而这一轮改的恰恰都是「丢了数据才发现」的逻辑——软删除、快照、分享白名单、检索历史裁剪。

### 做法
1. test/ 下用 node:test + node:assert/strict 写单测，package.json 加 npm test（node --test "test/*.test.mjs"）。不需要网络、不需要 Key、不碰生产。
2. 隔离靠临时目录：每个测试文件在 import 服务端模块之前把 DATA_DIR 指到 os.tmpdir() 下的新目录，config 就按它落 templates.json / search-history.json。
3. 覆盖这轮改动的不变量：
   - server/speech.mjs：语速表必须与 hypit 口径一致（zh 4.2 / 5.25 / 6.5625，en 4.2 / 4.6 / 5.6），单位换算（汉字 / 假名 / 英文音节）、0.8–60 秒钳制、1.2 与 0.55 两个阈值、缺结束时间时按台词补齐。
   - server/owner.mjs：归属矩阵——未登录不隔离、他人不可见、公共（无 ownerId）可看、管理员全看。
   - server/templates.mjs：软删过滤与回收站、彻底删除、编辑快照（没改内容不留、最多 10 版、回滚本身也留一版）、分享 token 生命周期（生成 / 查到 / 撤销 / 换新 / 进回收站即失效）与公开视图白名单（ownerId / versions / deletedAt / shareToken / blueprint 都不在）。
   - 回收站 30 天过期清理单独一个测试文件跑：模块有内存缓存，必须让新进程从磁盘读到那条 31 天前的记录，才能验证「列的时候顺手清掉条目与抽帧」。
   - server/search-history.mjs：相同条件重搜只更新时间、账号隔离、收藏不被清空带走、非收藏 40 条上限、界面 14 条分页。

### 验证
- node --test "test/*.test.mjs"：29 个测试全过，1.3 秒；npm test 同样 29/29。
- 断言写的是确切数字（例如「今天我们来拆这条爆款」= 10 个汉字、「用 VisionQA 拆解」= 3 个汉字 + 音节），不是「大概多少」——语速表被改回 4.5 字/秒这类回退会直接红。
- 全程不读 data/、不连 8799、不花积分；CI 里也就是这条命令。
---

## C3 前端异常上报与后台可见

### 问题
页面在用户浏览器里炸了，只有当事人看得见：脚本报错、Promise 没接住、图片挂了，全都没有落地的地方。用户能提供的信息通常只有一句「点不动」；服务端日志里什么都没有，因为请求根本没发出去。

### 做法
1. 服务端 server/client-errors.mjs：落 data/client-errors.json，封顶 300 条；同一条错误（同页面 + 同 message）10 分钟内只累加次数（updatedAt + count），超过 300 条丢最旧的。上报内容单行化 + 截断 + 抹掉 URL 里的 token / ticket / key / session / share / code 参数。
2. 公开接口 POST /api/client-errors（进 PUBLIC_API，登录页与分享页炸了也能报）：只取白名单字段，体积封顶 16KB（超了 413），按 IP 每分钟 30 条限流，跨域那种只有一句「Script error.」的不入库存。
3. 前端 src/lib/clientErrors.ts：捕获阶段监听 error（含 img/script 资源加载失败）、unhandledrejection，ErrorBoundary.componentDidCatch 额外报渲染错误。一次页面加载最多发 8 条、同一条 30 秒内只发一次；用 sendBeacon 发（页面崩了、要卸载了也能发出去），上报自身失败一律吞掉。
4. 后台「系统」页新增「前端异常」卡片：4 类（脚本错误 / 未处理 Promise / 页面渲染 / 资源加载）、条数、最近 24 小时上报次数、聚合记录列表（第几次、最近时间、页面、版本）、可展开看堆栈；带刷新与清空（清空记一条管理审计）。

### 验证（生产，入口 index-Cdfjf5bD.js）
- 未登录 POST /api/client-errors → 202 {ok:true, stored:true}；同一条再报 → 202，**返回同一个 id**（10 分钟内合并计数）。
- 20KB 的包 → 413；「Script error.」→ 202 {stored:false}，不入库。
- 带 token 的上报落库后是 `fetch failed /api/share/abc?token=***&x=1`，页面 `#/share/abc?token=***`——参数被抹掉。
- 未登录 GET /api/admin/client-errors → 401；限流：同一分钟连续上报，13 条通过后其余 27 条全部 429。
- 浏览器里造三条真实异常（未捕获 TypeError、未处理的 Promise、图片 404）：后台立刻出现三行，页面都记成 #/templates、版本 v0.1.0，其中未处理 Promise 那条展开能看到真实调用栈。
- 清空后 total 归零；自测数据没有留在生产里。

### 产物
![后台「系统」页的前端异常：类型、次数、页面、堆栈](screenshot-client-errors-2026-11-12.png)

### 边界
- 只收「浏览器里发生的」：服务端 5xx / 上游失败 / 磁盘水位仍然走「告警」那条线，两边不混。
- 不做 sourcemap 还原：生产堆栈是压缩后的位置，能看到是哪个页面、哪条错误、第几次，定位到函数需要结合本地复现。要还原映射得在发布时上传 sourcemap，本次不做。
