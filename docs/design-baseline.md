# 视觉基线（去 AI 味）

这份文件是前端的**交付底线**，不是上限。任何页面改完，逐条对一遍再交。

## 六条硬规则 → 我们的落实

| 规则 | 落实方式 | 落在哪 |
| --- | --- | --- |
| 间距只走 4/8pt 栅格 | `--space-1..16`（4/8/12/16/24/32/48/64），组件里不许出现 13/26/29 这类随手值 | `src/styles/tokens.css` |
| 禁大面积渐变 | 全站纯色底板（`#f4f4f4` 画布 / `#fbfbfb` 面板 / `#ffffff` 卡片），彩色只出现在「通过 / 待确认 / 问题」三个语义位 | `tokens.css` |
| 图标不用 emoji | 全部 lucide 线性图标，统一 `strokeWidth 1.5`；UI 里没有 emoji | 各页面 `tsx` |
| 字体显式指定 | Geist + Noto Sans SC 显式加载并给回退链；标题 500、辅助数据 400、等宽元数据 400 | `tokens.css` |
| 文案给信息不给寒暄 | 工作台页头从「下午好，演示用户」改成「3 项待办 · 3 条待评审 · 4 条今日入库」 | `OverviewPage.tsx` |
| 颜色先 token 后动手 | 六个基础位：`--canvas / --surface / --surface-raised / --ink / --muted / --line`，组件里不现调色 | `tokens.css` |

## Token 速查

```
间距   4 8 12 16 24 32 48 64          --space-1 / -2 / -3 / -4 / -6 / -8 / -12 / -16
字阶   10 12 14 16 20 28 40          --text-mono / -xs / -sm / -body / -lg / -xl / -2xl / -3xl
字重   300 400 500                   --weight-light / -normal / -medium
底色   #f4f4f4 #fbfbfb #ffffff        --canvas / --surface / --surface-raised
文字   #111111 #5d5d5d #6f6f6f        --ink / --muted / --faint
线条   rgba(17,17,17,.06/.10/.20)    --line-faint / --line / --line-strong
语义   #176b43 #8a5b08 #a33838        --pass / --warn / --fail（只用于评审结论）
```

## 2026-11-05 这一轮的整改

- **间距归一**：8 张样式表 449 处 off-grid 值收敛到栅格（1/2/3px 的发丝线与光学微调不动，也不算间距）。
- **字阶归一**：495 处 `font-size` 归到七个台阶；正文从 11.5–13px 提到 14px，等宽元数据保持 10–12px。
- **字重**：`h1/h2/h3` 与页头标题从 600 降到 500，视觉更稳。
- **文案**：工作台去掉问候语，页头改成三个真实计数；设置页「会话存储/登录方式」原来还写着 localStorage 和「密码不校验真伪」，与实际的服务端会话矛盾，已改成 `vq_session · HttpOnly cookie` 与 scrypt 比对。
- **工具条**：模板库原来「搜索框 + 9 个类型 chip」挤在一行换行、边界发糊，改成**搜索一行、类型一行**（下划线式 tab，横向不换行）。
- **形态开关**：从 150px 的三行卡片收成一行（左侧形态名 + 右侧三个图标），不再换行。

## 自检

- `font-size` 只剩七个台阶 + 等宽 10/12 两档。
- 间距只剩 4/8/12/16/24/32/48/64（外加 1–3px 发丝线）。
- 没有 emoji，没有整屏渐变，没有系统默认字体。
- 截图：`docs/screenshot-workbench.png`、`screenshot-templates.png`、`screenshot-review.png`、`screenshot-settings.png`。

## 还没做

- 雷达页「示例数据 · 无封面」的空封面块仍然偏大，占掉半屏；等有真实封面素材再重排。
- `App.css`（遗留样式表）里还有一批旧类在服务模板库/雷达，本轮归了间距与字阶，但没有重构结构。
