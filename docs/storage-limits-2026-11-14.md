# 素材占用上限：谁的帧图占了多少盘，到顶就不接新任务（v0.9.68）

> 日期：2026-11-14 · 版本：0.9.68（生产 0.9.68b，入口 `index-DgjMcNs0.js`）
> 上一轮：[上线就绪与站点公示](readiness-and-site-info-2026-11-14.md)（v0.9.67）

## 一、问题

上线差距清单里的 B1 一直挂着：**帧图没有总量上限**。一次复刻往 `DATA_DIR/frames/<模板 id>/` 写十几帧图片，一个账号复刻几十条就是几百兆；而 SQLite、备份归档与帧图在**同一块盘**上（40 G，已用 71%）。磁盘写满时坏的不是一个账号——库写不进去、备份也写不出来，整站一起停。

后台原本只有「数据存储」卡的**总占用**（谁占的、占了多少都没有）。这次补三件：

1. **按账号算占用**：帧图按模板归属算在创建人名下；
2. **上限可设**：默认 0 = 不限，可按账号单独覆盖；
3. **到顶在任务入口拦**：一键复刻在扣费与调用上游之前返回 429，那一单不扣积分。

## 二、代码怎么落

| 位置 | 做了什么 |
| --- | --- |
| `server/storage.mjs`（新） | 上限存 `DATA_DIR/storage-limits.json`（0600、原子写）；按模板归属汇总帧图占用；`storageRoom()` 是任务入口的闸门；`cleanOrphanFrames()` 只删「没有任何模板指向」的目录 |
| `GET /api/storage`（新） | 当前账号自己的占用与上限。**只回自己的数**，不回别人的、也不回磁盘总量 |
| `GET/PUT /api/admin/storage` | 原「数据存储」接口加 `frames / shared / orphans / accounts / limits`；PUT 改默认上限 |
| `PUT/DELETE /api/admin/storage/overrides/:userId` | 按账号单独设 / 清（0 = 这个账号不限） |
| `POST /api/admin/storage/clean` | 清理孤立帧图目录 |
| `POST /api/replicate` | 扣费与上游调用**之前**过闸门，超了 429 `STORAGE_LIMIT` |
| 后台「系统 → 素材占用上限」 | 默认上限编辑、按账号占用表（可单独设/恢复默认）、孤立目录清理 |
| 设置页「素材占用」 | 「管理员没设上限」或「上限 X / 已用 Y」，到 80% 与 100% 分别变黄与变红 |

审计新增 `storage.save`（改上限，只记 MB 数与作用对象）、`storage.clean`（清理，记目录数与字节数）。

## 三、生产实测（v0.9.68b，零扣费）

| 检查 | 结果 |
| --- | --- |
| `/api/version` / health | `0.9.68` / ok，templates 26，两个服务 active |
| `GET /api/admin/storage` | 数据目录 21,088,735 B / 352 文件；帧图 18,830,661 B / 315 文件 / **25 个模板目录**；磁盘余 11.85 GB / 共 41.88 GB |
| 归属口径 | 25 个目录全部属于**公共示例**（`shared`，不记在任何账号头上）：管理员账号 0 个模板、0 B；`limits.defaultMb = 0` |
| 孤立目录 | `orphans.count = 0`（每个帧图目录都还有模板指向） |
| `GET /api/storage` | `bytes 0 / unlimited true / remainingBytes null`（不编假余量） |
| 设默认 200 MB | 后台胶囊 `不限 → 默认 200 MB`、行内上限同步为 `默认 200 MB`；设置页文案换成「上限 200.0 MB，到顶后复刻会被拒」 |
| 收尾 | 改回 `defaultMb = 0`，再删掉 `storage-limits.json`；复查 `defaultMb 0 / unlimited true`，服务器上 `no-limits-file` |
| 窄屏 390 | `docScrollWidth 390`，页面无横向滚动；账号表在卡片内横向滚动（与后台其它表一致），默认上限表单与孤立目录按钮竖排满宽 |
| 控制台 | 后台与设置页 0 异常；**本轮没有扣积分的调用** |

## 四、闸门怎么验的（生产没有自己的帧图，所以另起一个实例）

生产上 25 个帧图目录都是公共示例，管理员账号名下 0 B——上限设多少都不会「到顶」。所以用**同一份代码**在本地起一次性实例（`DATA_DIR` 指临时目录、`VQ_REQUIRE_AUTH=1`、该账号设为管理员），造一个 2 MB 的帧图目录与一条归属它的模板，实测：

```json
{
  "storageBefore": { "bytes": 2101248, "unlimited": true },
  "setLimit":      { "status": 200, "defaultMb": 1 },
  "storageAfter":  { "bytes": 2101248, "limitMb": 1, "over": true, "percent": 100 },
  "replicate": {
    "status": 429,
    "code": "STORAGE_LIMIT",
    "error": "素材占用已到上限：已用 2.0 MB，上限 1 MB。一次复刻要往服务器写十几帧图片，所以到顶后不再接新任务（这一单不扣积分）。删掉不用的模板（回收站里的也要彻底删除）就能继续；管理员可以在后台「系统 → 素材占用上限」给这个账号单独放宽。"
  },
  "credits": { "before": 100, "after": 100, "unchanged": true },
  "restore":  { "status": 200, "defaultMb": 0 },
  "unlimitedAgain": { "limitMb": 0, "unlimited": true }
}
```

要点：**429 发生在扣费之前**——余额 100 → 100，任务草稿也没落库。这条路径同时说明闸门不会「扣了钱再拒」。

## 五、边界（都不藏着）

- **软上限**：只在「已经到顶」时拒绝，不预测一次复刻要写多少兆。所以一个账号最多超出「一次任务」的量，不会超出两次。估个数反而会拦错（同样是 18 帧，清晰度不同差好几倍）。
- **只算帧图**：日志、备份归档、SQLite、模板 JSON 都不计。0 表示不限，是现在的默认值。
- **公共示例不算任何人的**：`shared` 的运营种子内容不记在账号头上；代价是「谁在占」只对用户自己的模板成立。
- **回收站仍算占用**：模板进回收站时帧图还在盘上，彻底删除后才释放；彻底删除之后若目录残留，会出现在「孤立帧图」里等清理。
- **画布出图暂不计入**：真实出图还没验（等你授权一次生成调用），量也还没起来；接上之后同一个闸门可以挂到画布节点上。
- **这不是「上线就绪」的第七道门**：六道门是收钱前置条件，素材上限是运维护栏，不挡上线。

## 六、复验命令

```bash
ssh root@139.196.123.28 'curl -s -b /tmp/vq-cookie https://visionqa.wavisionai.cn/api/admin/storage' | head -c 800
# 上限：改成 1 MB 看 /api/storage 的 over，再改回 0
curl -s -X PUT -b cookie.txt -H 'Content-Type: application/json' \
  -d '{"defaultMb":1}' https://visionqa.wavisionai.cn/api/admin/storage
curl -s -b cookie.txt https://visionqa.wavisionai.cn/api/storage
# 本地端到端（不碰生产）
node .tmp-qa/r79-e2e.mjs
```

回滚：`ops/rollback.sh --to 2`（回到 v0.9.67b）。`storage-limits.json` 不存在时行为与之前完全一致（默认不限），回滚不需要改数据。

## 七、这一轮改了什么

- 新增：`server/storage.mjs`、`server/routes/storage.mjs`、`src/api/storage.ts`、`src/pages/admin/StorageGuard.tsx`、`test/storage.test.mjs`（9 条）、本文与 4 张截图。
- 改动：`server/index.mjs`（`/api/storage` 路由 + 复刻闸门）、`server/routes/admin.mjs`（存储接口 + 上限接口 + 清理）、`server/audit.mjs`（两个动作）、`src/pages/admin/SystemSection.tsx`（挂载卡片）、`src/pages/SettingsPage.tsx`（素材占用一行）、`src/styles/console.css`、`src/pages/LegalPage.tsx`（帧图保留口径写实）、`src/domain/help.ts`（新增「磁盘满了」一节）。
- 质量：`npm test` **601/601**（+9）、oxlint 0 error / 7 warning、`tsc -b` 干净、构建通过；本轮无扣费调用。

## 八、截图

1. `screenshot-storage-guard-2026-11-14.png` —— 后台默认状态（不限、25 个公共示例目录、无孤立目录）
2. `screenshot-storage-guard-limit-2026-11-14.png` —— 临时设 200 MB（截完已改回不限并删文件）
3. `screenshot-storage-settings-2026-11-14.png` —— 设置页「素材占用」：未设上限时的口径
4. `screenshot-storage-guard-mobile-2026-11-14.png` —— 390 宽
