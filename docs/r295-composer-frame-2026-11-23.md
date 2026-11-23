# r295 输入卡只有一层框（2026-11-23，v0.9.277）

## 用户报的问题

> 我不想要这个框 和图片视频那边一样调整一下

配图圈的是快捷创作「对话 → 平台对话」那张输入卡：文字外面**还有一圈 1px 直角黑框**，
右下角带一个缩放柄。同样一页切到「图片 / 视频」，输入卡只有外面那层圆角卡，里面干干净净。

## 先查这圈框是谁画的（1424×805 视口，真实渲染取值）

那圈框不是卡片自己的描边，是叠在一起的三个东西：

| 层 | 来源 | 实测 |
| --- | --- | --- |
| ① 卡片（该有） | `.qc-composer` / `.agx-composer` 的 1px 描边 + 圆角 | 图片 / 视频也有，正常 |
| ② **多出来的黑框** | `.agx-page textarea:focus-visible { outline: 1px solid var(--ink); outline-offset: 2px }` | 点进输入框就出现；Chrome 对文本输入框**总是**判 `:focus-visible`，鼠标点也会亮 |
| ③ 右下角缩放柄 | `.qc-input { resize: vertical }` | `.agx-textarea` 一直是 `resize: none` |

②之所以漏网：`.qc-input:focus { outline: none }` 只压了 `:focus`，压不住 `:focus-visible` 那条更具体的选择器。
r259 给 `.agx-composer .agx-textarea:focus-visible` 让过一次位（那段注释写的就是「外圆内方」的第二道框），
但对话这张卡是另一个组件（`.qc-*`），没跟上。

## 改法（只动 CSS，另有 1 条测试钉住）

1. `.qc-composer .qc-input:focus, .qc-composer .qc-input:focus-visible { outline: 0 }` —— ②没了。
2. `.qc-input` 的 `resize: vertical` → `none` —— ③没了（窄屏那两条断点原本就是 none）。
3. 焦点提示不能跟着一起消失：`.qc-composer` 补齐 `:focus-within`（边框转墨 + `--ring-soft` 柔光），
   描边与阴影也升到和 `.agx-composer` 同档（`--line-strong` / `--shadow-card`）。点进去时整张卡变，里面不再画第二层。
4. `test/quick-composer-unified.test.mjs` 新增「输入卡只有一层框」：textarea 不许描边、不许有缩放柄、
   焦点环必须按在整张卡上，两张卡的描边与阴影必须是同一档。

## 改完实测

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| 对话 textarea 描边 | `border: 0` | `border: 0`（不变） |
| 对话 textarea 聚焦时 outline | `1px solid rgb(17,17,17)`（offset 2px） | **none / 0px** |
| 对话 textarea 缩放柄 | `resize: vertical`（右下角有柄） | **none** |
| 对话卡片聚焦时 | 边框仍是 `rgba(17,17,17,.2)`，无 ring | **边框 `rgb(17,17,17)` + 4px 柔光** |
| 图片 / 视频 textarea | none / 0px、resize none | 同（未变） |

390×844：`innerWidth == scrollWidth == 390`，输入卡 290 宽、输入区 64 高，仍然只有一层框。

## 截图

- `docs/r295-before-chat-focus-1440.png` —— 改前：注入旧规则复现的那圈黑框 + 右下角缩放柄。
- `docs/r295-after-chat-focus-1440.png` —— 改后：聚焦状态，只有整张卡一层框。
- `docs/r295-after-chat-1440.png` —— 整页（v0.9.277）。
- `docs/r295-after-media-1440.png` —— 图片页签，作为「一样」的参照。
- `docs/r295-after-chat-390.png` —— 390 窄屏。

## 边界

- 发送按钮没动：对话是 40px 圆角方块 + 上箭头，图片 / 视频是 40px 圆形 + 图标。形状不一样是有意的（发送 vs 出图），
  但这和 r256 那句「同一个圆形发送键」对不上，要不要统一等用户点头。
- 390 的输入卡仍 `position: sticky; bottom: 8px`，空状态较长时会被压住一截（r294 起就是这样，本轮没动）。
- 本轮 0 次真实上游调用、0 费用；截图来自本机临时实例（临时 DATA_DIR + 临时账号 + 同一份 dist），跑完已删。
