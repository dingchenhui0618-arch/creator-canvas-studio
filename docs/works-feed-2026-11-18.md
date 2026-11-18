# 作品流：三处产物汇成一条（r213 契约）

目标：快捷创作（图片/视频）、工作流运行产物、无限画布里的创作，都在「作品」页看到，
按作品本身的比例排版（默认 9:16 竖版卡片，瀑布流），不再只列「作品项目」。

## 数据来源（都在本仓库，不新增第三方依赖）

1. 快捷创作：`DATA_DIR/media/<userId>/` 下的任务元数据（见 server/media.mjs 的 listTasks/recent 逻辑；
   已有 `GET /api/media/tasks` 的取数函数，直接复用，勿另写一套）。
2. 工作流：`runs.json` / `run-graphs/`（见 server/runs 模块与 src/pages/RunsPage.tsx 的字段：
   id、flowName、status、createdAt、产物里的脚本/分镜/评审链接）。
3. 无限画布：`server/bdc.mjs` 的 `listCanvases()` 给出 id/name/nodeCount/updatedAt；
   需要缩略图时 `loadCanvas(id)` 读节点里的图片节点（形如 `data.imageUrl` / `data.src` / `data.url`，
   以画布 store 的实际结构为准），没有就退回「画布 · N 个节点」卡，别编图。

## 接口 `GET /api/works`（server/routes/works.mjs 已注册）

query：`kind=all|image|video|run|canvas`（默认 all）、`before`（游标，上一页最后一条的 `at` + id）、`limit`（默认 24，上限 48）。
返回：
```json
{ "ok": true, "items": [{
  "id": "media:task_x" | "run:xxx" | "canvas:canvas_id",
  "kind": "image"|"video"|"run"|"canvas",
  "title": "…",
  "aspect": "9:16"|"16:9"|"1:1"|"unknown",
  "thumbUrl": "/api/media/tasks/<id>/file" | null,
  "previewUrl": "…" | null,
  "at": 1763... ,
  "source": "快捷创作"|"工作流"|"无限画布",
  "detailUrl": "#/media" | "#/runs" | "#/board/<id>" | "#/project/<id>"
}], "total": 0, "cursor": null }
```
- 只返回当前账号可见的内容（自己的；管理员可见规则沿用现有 canAccess）。
- 不存在的 kind 400 `WORKS_KIND`；坏游标 400 `WORKS_CURSOR`；未登录 401。
- 不调上游、不扣积分、只读。

## 页面（src/pages/ProjectsPage.tsx）

- 顶部两个视图：「创作成果」（默认，瀑布流）与「作品项目」（现有列表原样保留，逻辑一行不动）。
- 瀑布流：卡片按 aspect 决定高度（9:16 → 3:4 卡片高度按比例；16:9 横卡；unknown 用方卡），
  一列/两列/四列随宽度 390/768/1440；缩略图懒加载、hover 显示来源与时间；点开看大图/视频（弹层，Esc 关闭）。
- 筛选：全部 / 图片 / 视频 / 工作流 / 画布；「看更早的」游标翻页（与最近生成同一交互习惯）。
- 任何位置不出现上游品牌名与「红狐」字样。
- 复用现有 token 与 `projects.css`/新建 `works.css`；390 宽无横向溢出。

## 验收

- `test/works-*.test.mjs`：三种来源合并排序、kind 过滤、游标翻页、越权隔离、坏游标 400。
- `npx vitest run test/works-*.test.mjs` 全绿；不跑 tsc/build（Lead 统一跑）。
- 截图：1440 与 390 各一张，落到 docs/works-1440.png / docs/works-390.png（本机临时实例即可，用假数据）。
