# 排版参考：Pachat 聊天页（2026-11-12 实测）

用户给的参考：https://pachat.ai/chats/gfOxWgl7RjspVTNJ （需登录，在用户浏览器里打开实测）。
这份文件记的是**量出来的样式值**，以及我们怎么把它映射到 VisionQA——不是把 Pachat 的界面搬过来。

## 一、量到的值（Chat 页 1777×881，Chrome / Windows）

| 项目 | Pachat 实测 |
| --- | --- |
| 拉丁字体 | Figtree（标题与正文同一套） |
| 中文回退 | PingFang SC / Noto Sans SC / Microsoft YaHei |
| 正文 | 15.5px / 行高 21.7px（1.4）/ 400 / rgba(0,0,0,.82) |
| 名字与按钮 | 13.5–14px / 600 |
| 元数据 | 12.5–13px / 400 / rgb(110,110,115) |
| 次级文字 | 11–11.5px / 600 / rgb(74,74,80) |
| 群标题 | 19px / 行高 28.5px（1.5）/ 600 / rgb(20,20,20) |
| 主正文色 | rgba(0,0,0,.86) |
| 消息列表 | padding 18px 24px 6px，消息间距 13px |
| 会话栏 | 宽 280px，padding 16px |
| 工具轨 | 宽 84px，padding 16px 6px，图标间距 4px |
| 聊天头 | padding 12px 24px，gap 10px 20px |
| 输入区 | 外框 padding 14px 24px 20px；输入卡片 radius 20px，padding 10px 10px 8px 16px |
| 圆角 | 4 / 6 / 8 / 9 / 12 / 14 / 16 / 20 / 28 / 30 / 999 |
| 间距 | 以 2px 为细粒度，主要落点 4 / 6 / 8 / 12 / 16 / 20 / 24；没有大面积 8 的倍数强制 |
| 按钮 | 32–38px 高，胶囊或 9–14px 圆角，字重 600 |

## 二、我们怎么用

- **字体**：自托管 Figtree（`public/fonts/figtree.woff2`，20KB，SIL OFL）放在 `--font-ui` 第一位，
  Geist 退到第二位、Geist Mono 继续做等宽元数据。中文仍走系统黑体。
- **字阶**：新增阅读面 token `--text-copy: 14px` / `--leading-copy: 1.7` / `--text-meta: 12px` / `--leading-meta: 1.6`。
  中文行高比 Pachat 的 1.4 放宽到 1.7（汉字没有西文的下伸部，1.4 会挤）。
- **间距**：遵守项目 4/8pt 规则，把 Pachat 的 13/18/24 落点映射成 12/16/24：
  作品页面板 padding 16→24、区块 gap 12→16、列表卡片 padding 16→24。
- **按钮**：30px/12px → 32px/13px，贴近 Pachat 的 32–38px 控制高度；不改胶囊与主色，
  避免把「工具型工作台」做成聊天气泡。
- **不照搬**：整屏柔和渐变、玻璃拟态、聊天气泡布局都是 Pachat 的场景语言；
  VisionQA 仍保持近黑白、发丝线、取景框的编辑台气质。

## 三、落地位置

- 字体：`src/styles/tokens.css`（`@font-face` + `--font-ui`）。
- 阅读面字阶：`tokens.css` 的 `--text-copy` / `--leading-copy` / `--text-meta` / `--leading-meta`。
- 作品页与作品列表：`src/styles/projects.css`（脚本、分镜、评审、来源、运行记录、卡片）。
- 通用按钮：`src/styles/shell.css`（`.vq-button`）。

## 四、下一屏怎么继续用

- 新的阅读型页面（作品分享页、评审报告）直接用 `--text-copy` / `--text-meta`，不要另写 12px。
- 面板 padding 有 24 就够，不要再堆到 32；列表行距 16。
- 标题与数值仍用 500/300 字重，正文 400，只有名字与按钮用 600。
- 每次改完至少看 1440 与 780 两个宽度的实拍，确认没有换行挤压或溢出。
