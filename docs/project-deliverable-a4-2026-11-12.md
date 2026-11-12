# 交付稿的 A4 打印版（v0.9.3，2026-11-12）

## 一、为什么还要一张纸

v0.9.2 给了交付稿的 Markdown 文件：能发给剪辑、能贴进文档、能进版本库。
但真实交付里还有两种场景它接不住：

1. **编导要在纸上改。** 折叠动作哪里多了一句、哪个镜头念不完，用笔圈比在编辑器里翻行快。
   拿到的却是一份 `.md`，得先找编辑器、套模板、调页边距。
2. **制片要在群里发一张纸。** 发 `.md` 等于让对方带着电脑看；发 PDF 才是发「稿子」。

所以这一片是给交付稿加**第二个出口**：作品页点「打印稿」，新标签里是一张排好版的 A4，
按一下「打印 / 存为 PDF」，纸张已经写死 A4，只剩选「另存为 PDF」。

| 之前 | 现在 |
| --- | --- |
| 只有 `.md`，要纸得自己排版 | 服务端直接出 A4 版式：抬头事实表、小节自动编号、镜头不跨页 |
| 打印前得装个 Markdown 编辑器 | 浏览器打印（Ctrl+P / 页面按钮），不新增依赖，中文断行交给浏览器 |
| 纸上的内容与稿子可能两套口径 | 打印版由**同一份 Markdown** 渲染，两份永远同文 |

## 二、怎么实现的

三层，都很薄：

| 层 | 文件 | 做什么 |
| --- | --- | --- |
| 内容 | `server/project-deliverable.mjs`（v0.9.2 已有） | 作品详情 → Markdown。这一轮没改结构，只修了两处措辞与抬头行 |
| 排版 | `server/project-deliverable-html.mjs`（新） | Markdown 子集 → A4 的 HTML（内联样式，不依赖构建产物） |
| 路由 | `server/routes/projects.mjs` | `GET /print/projects/:id/deliverable?tz=480` → `text/html` |
| 入口 | `src/pages/ProjectPage.tsx` / `src/api/projects.ts` | 页头「打印稿」，`window.open` 新标签（时区跟着地址走） |

### 为什么从 Markdown 再渲染一次

这是这一片唯一需要解释的设计决定。另外两条路都比它贵：

- **照作品详情再写一遍排版**：内容组装写第二遍，等于承认「文件里一个时间、纸上另一个时间」迟早会发生。
  上一片为了「口径同源」刚把详情组装提成 `projectDetailView()`，这里不能倒回去。
- **服务器装 Chromium 出 PDF**（Puppeteer）：多 300MB 依赖、多一个常驻进程，而浏览器自己就有 PDF 引擎，
  中文断行、字体、分页都是它最擅长的部分。

代价是渲染器要吃 Markdown。好在这份 Markdown 是我们自己生成的，记号只有七种：
`# / ## / ###`、`- `、`1. `、`> `、表格、`**粗体**`、`---`。
渲染器只认这七种，遇到不认识的行按段落输出——**宁可难看，也不吞内容**。

安全上只有一条：所有文本先转义再拼标签。作品标题或台词里写着 `<script>`，纸上也只是字
（测试 `project-deliverable-print.test.mjs` 有两条断言盯住它）。

### 排版规则（都写在 `PAPER_CSS` 里，单位 pt / mm）

- **纸**：`@page { size: A4; margin: 16mm 14mm }`。屏幕上是一张 210 × 297mm 的纸（794px 宽），
  打印时内容区 182mm，两边同一套数字。
- **字**：正文 10pt / 行高 1.7，标题 22 / 13 / 10.5pt，表格 8.5pt；拉丁用自托管 Figtree，
  中文走系统黑体（Windows 微软雅黑 / macOS 苹方）——印刷场景下系统字体带 hinting，比网页字体清楚。
- **抬头**：标题、引题、事实表三件。事实表用 `grid-template-columns: max-content 1fr` +
  `li { display: contents }`，标签列宽取最长那个、值整列对齐；拆不出「标签：值」的行整行放进值里，不丢字。
- **小节**：`h2` 用 CSS 计数器自动编号（01 … 07），不把编号写进 Markdown——否则文件里也带上印刷用的装饰。
- **分页**：`h2 / h3` 后 `break-after: avoid`，`h3 + ul`、表格、引用、事实表 `break-inside: avoid`；
  表头 `display: table-header-group`，跨页时表头重出。
- **表格**：首列（时间 / 版本）与末列（念完 / 积分 / 归档）`white-space: nowrap`，其余 `word-break: break-word`。
  折行折在「时间」或「3.2 秒 · 偏多」上比不折更难读。
- **手机**（≤700px，只在屏幕上）：宽表自己横向滚（表格改 display: block + overflow-x: auto），
  不把整页顶出屏幕（390 宽实测：页面横向溢出从 420 收到 390）；打印时仍是正常表格。

### 出错也给一张纸

这个地址是在新标签里打开的，吐一段 JSON 会让人以为页面坏了：

| 情况 | 返回 |
| --- | --- |
| 没登录 / 登录过期 | `401` + 「登录已过期」，一个「去登录」的按钮 |
| 作品被删了 | `404` + 「作品不在了」，一个「回作品列表」的按钮 |

两条都带 `Cache-Control: no-store` 与 `X-Robots-Tag: noindex`：稿子会随作品变，也不该被搜索引擎收录。

## 三、nginx 这一处最容易漏

生产是 nginx 直接托管 `/opt/visionqa/dist`：

```nginx
location / { try_files $uri $uri/ /index.html; }
```

也就是说 **`/print/...` 不加一条反代，拿到的会是 SPA 首页**（200 + `text/html`，看起来「成功了」，
打开却是一个应用壳）。这一条不加，功能就等于没上线，而且报错很安静——这轮唯一需要动线上配置的地方：

```nginx
location ^~ /print/ {
    proxy_pass http://127.0.0.1:8799;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
}
```

- `^~` 放在正则之前匹配，避免被别的 `location ~` 抢走。
- 五个安全头要重写一遍：nginx 的规则是**某个 location 里出现 `add_header`，server 级的就不再生效**。
- 线上：先备份 `/root/visionqa.wavisionai.cn.conf.bak-20261112-print`，改完 `nginx -t` 通过才
  `systemctl reload nginx`（失败自动回滚）。
- 仓库里 `deploy/nginx.conf` 同步补上，重装机器时不会漏。

## 四、生产实测（作品「毛衣折叠收纳法」v2）

| 项 | 结果 |
| --- | --- |
| 页头按钮 | 刷新 / 标记交付 / 导出交付稿 / 打印稿 / 分享 / 删除，1440 宽一行（32px 高），标题 1 行、无横向溢出 |
| 真点击 | CDP 真实鼠标事件点「打印稿」→ 新标签 `/print/projects/prj_f38d68c6/deliverable?tz=480`（标签数 165 → 166） |
| 页面 | **18,947 B**、`text/html; charset=utf-8`、`no-store`、`noindex`；7 个小节、3 张表、8 个镜头 |
| PDF | **5 页 / 444,140 B**（`docs/sample-deliverable-2026-11-12.pdf`，`preferCSSPageSize`） |
| 控制台 | **0 异常** |
| 未登录 | `401` + 「登录已过期」+「去登录」，页面里没有打印按钮 |
| 作品不存在 | `404` + 「作品不在了」 |
| 780 宽 | 六个动作整行下移到自己一行，标题 1 行，无横向溢出 |

纸上的内容与 `.md` 同源，抽验几处：`台词约需 25.3 秒，原片 18 秒，按语速档「中」估（5.25 字/秒）`、
8 段脚本（7 段标「偏多」）、5 个问题 + 3 条修正建议、v1/v2 对照、6 次运行里 3 次失败原因、
末尾「由 VisionQA 导出 · 8 段脚本 / 8 个镜头 · 画布 2 个节点」。稿子里仍然**没有分享 token**。

截图：

- `docs/screenshot-project-print-2026-11-12.png`：打印页本身（顶栏 + A4 纸）。
- `docs/screenshot-project-print-a4-2026-11-12.png`：把窗口收到 820 宽，纸按 210mm 展开的第一页。
- `docs/screenshot-project-print-780-2026-11-12.png`：780 宽作品页，六个动作不挤标题。

## 五、顺手修的两处

1. **评审那一行在纸上粘成一句**：`最新一次（v2）：需人工确认 · 2026-11-12 18:03` 与
   `模型 … · 38 秒` 在 Markdown 里是同一段的两个软换行，渲染后变成「18:03 模型 …」。
   元信息行前面补一个「· 」，一段读下来是「… 18:03 · 模型 … · 38 秒」。
2. **抬头几行没有冒号**：`建立 2026-11-12 17:06 · 最后更新 …`、`导出时间 …` 在事实表里落不到标签列
   （整行挤到「值」那一列）。统一成「标签：值」，`最后更新` 独立一行——
   文件里读着整齐，纸上也因此才对齐。

## 六、验收

- 生产 **v0.9.3**、入口 `index-CarVCfDG.js`、release `20261112-135857-0.9.3.tar.gz`、
  `/api/health` ok（templates 26）。
- `npm test` **114/114**（新增打印版 7 条：抬头三件、表格、转义、列表引用、空输入、整份同文、出错页）。
- oxlint **0 error / 7 warning**；`npm run build` 通过。
- nginx `-t` 通过后 reload；备份留在服务器 `/root/visionqa.wavisionai.cn.conf.bak-20261112-print`。

## 七、还没做

- **页码**：浏览器打印对话框里打开「页眉和页脚」才有页码（页面顶栏已经这么提示）。
  CSS 的 `@page` 页码盒 Chrome 还不支持，硬做只能靠 position: fixed 叠字，容易压到正文，不做。
- **每份稿子带一张封面**：现在是抬头三件套（标题 / 引题 / 事实表）。封面会多一页纸，
  等编导说「要一张能签字的封面」再加。
- 交付稿其余三项待办不变：**全版本导出**、**帧图打包**、**打印时选段**（只要脚本 + 分镜）。
