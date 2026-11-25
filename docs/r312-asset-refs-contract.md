# r312 · 资产引用契约（模板 / 工作流节点 / 出视频）

r311 把资产「建」出来了；r312 要让资产「用得上」。
本文是服务端与前端唯一对齐口径，两边照这一份写，不要各造一套。

## 一条引用的形状

```
asst_<base36 时间戳>_<4~12 位十六进制>:<槽位名>
例：asst_mf3k2p_ab12cd:hero
```

- 正则：`/^asst_[a-z0-9]{6,20}_[a-z0-9]{4,12}:[a-z]{3,10}$/`（`server/asset-ref.mjs` 的 `ASSET_REF`）
- 槽位名：产品 `hero|scene|detail|pack`，数字人 `front|half|side|action`（`server/asset-prompts.mjs`）
- 只认**已经有图**的槽位。没生成出来的槽位不进选择器；写进节点也能跑，但运行时会明确失败并**不扣积分**。

## 服务端已经有的（r312 本轮由 Lead 先落）

| 东西 | 位置 | 说明 |
|---|---|---|
| `ASSET_REF` / `normalizeAssetRef` / `splitAssetRef` / `assetRefToken` / `assetRefLabel` | `server/asset-ref.mjs` | 纯函数，非法值回空串，不抛 |
| `readAssetReference(ownerId, token)` | 同上 | 归属校验 + 读字节 + 压到长边 1024 JPEG；读不到抛 `ASSET_REF_MISSING`（400），**必须在扣费之前调** |
| `listAssetRefOptions(ownerId)` | 同上 | 只列 ready/partial 且有图的槽位 |
| `GET /api/assets/refs?kind=product\|avatar` | `server/routes/assets.mjs` | 回 `{ ok, refs: [{ id, assetId, kind, name, slot, label, full, url, width, height }] }` |

`full` 是给人看的一句：`产品「美式咖啡机」· 白底主图`。

## 工作流节点（服务端 A / 前端 B）

- 出图、出视频节点的 `config` 多一个字段 `assetRef`（字符串，默认 `''` = 不引用）。
- 服务端 `normalizeConfig` 里用 `normalizeAssetRef` 归一，非法值存 `''`（不报错、不拒绝保存）。
- 运行时：**先 `readAssetReference` 再扣费**。资产被删/没图 → 节点失败，错误文案用它抛的 `ASSET_REF_MISSING` 那条，不扣积分。
- 出图带参考 → `runImageChain({ …, edit: { image, mime, filename } })`（同资产库那套 `/images/edits`）。
- 出视频带参考 → `createVideoChain({ …, payload: { …, referenceAssets: [{ kind:'image', mime, ext, bytes }], mode:'image2video' } })`。
- 节点输出文本里要写清楚这一张用了哪套资产（`参考资产：产品「…」· 白底主图`），否则用户看不出差别。

## 快捷创作 / 作品页逐镜出图（服务端 A / 前端 B）

`POST /api/media/generate` 的 `assets` 数组里可以直接放**资产引用**（`asst_x:hero`），与参考素材 id（`m_xxx`）混着放：

- 引用按 `readAssetReference` 读，按 1 张图算进 `mode` 的张数校验；
- 任务元数据里记成 `assets: [{ id: 'asset:asst_x:hero', kind: 'image', name: '产品名 · 白底主图' }]`，`publicTask` 照旧只回形状；
- 归属：别人的资产 / 已删 → 400 `ASSET_REF_MISSING`，与「参考素材不在了」同一档。

前端出图时：选了资产就传 `mode: 'reference'`（图）/ `mode: 'first'`（视频首帧）+ `assets: [token]`。

## 作品（模板展开的那条）

- 作品对象多一个 `assetRef` 字段（默认 `''`），`PATCH /api/projects/:id { assetRef }` 写它，传空串清掉。
- 作品页「出这一镜」：有 `assetRef` 就带参考出图，没有就还是纯文生图（**不改变默认行为与价格**）。
- 「开工作流」用 `buildReplicateDraft({ …, assetRef })`：按分镜建的 `n_shot_NN` 出图节点继承这个引用；
  `patchCanvasScript` 同步脚本时也把 `assetRef` 一起同步到这些节点（只认 `n_shot_NN`，不碰用户自己拉的节点）。

## 价格

**不变。** 带参考图与不带参考图都是每张 3 积分（当前主通道），出视频仍按秒 × 清晰度。
界面不许因为「带了资产」写另一套价格。

## 不许做的事

- 不许为了「总能出图」在资产读不到时静默退回纯文生图 —— 那就等于骗用户「用了我的商品图」。
- 不许把资产引用塞进公开分享页 / 离线包 / 导出 JSON（资产是账号私有物）。
- 不许在界面出现上游品牌名；用户可见只有「参考资产」这套说法。
