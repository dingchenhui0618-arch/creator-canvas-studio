# r311 身份引导与自有资产 · 前后端契约（唯一真源）

日期：2026-11-24　状态：实施中（后端由 Lead 写，前端按本文件实现）

## 为什么做这一步

复刻的前提不是「AI 帮我拍」，而是**用户手里先有属于自己、可以被反复调用的东西**：
自己的商品图和自己的人像。没有这两样，一键复刻只能是无源之水。
所以注册后的第一件事不是找爆款，而是**建资产**。这一轮只做这一段，不动复刻链路。

## 一、身份引导

注册 / 首次登录后弹全屏引导（不可跳过身份这一步）：

1. 选身份：`creator` 自媒体创作者 / `commerce` 电商产品生产 / `agency` 品牌代运营
2. 选类目：服装、美妆个护、食品饮料、家居日用、数码 3C、母婴宠物、本地生活、其他
3. 填方向（可选，≤20 字）：例如「穿搭口播」「家居收纳好物」
4. 进入建资产（产品资产 / 数字人资产），可「以后再说」，但每次进工作台会提示

### 接口

`GET /api/onboarding` →
```json
{
  "ok": true,
  "identity": "creator|commerce|agency|",
  "category": "",
  "direction": "",
  "identityAt": "ISO|null",
  "doneAt": "ISO|null",
  "done": false,
  "skippedAt": "ISO|null",
  "counts": { "product": 0, "avatar": 0 },
  "needs": { "identity": true, "asset": true }
}
```

`PUT /api/onboarding` body `{ "identity": "commerce", "category": "服装", "direction": "穿搭口播" }` → 同上（identity 必填，且只接受三个枚举值）

`POST /api/onboarding/complete` body `{ "skipAssets": false }` → 同上。`skipAssets: true` 表示「现在不建资产」，会记 `skippedAt`；没建过任何资产时默认也允许完成，但返回体里 `needs.asset` 仍为 true（界面照此提示）。

错误：`400 ONBOARDING_IDENTITY`（identity 不合法）、`401`（未登录）。

## 二、资产

两种：`product`（产品资产）、`avatar`（数字人资产）。

### 资产形状（前端直接用）

```ts
type AssetRef = {
  slot: string        // 见下
  label: string       // 「白底主图」
  url: string         // /api/assets/<id>/files/<slot>，需登录
  width: number | null
  height: number | null
  bytes: number
  createdAt: string
}

type AssetSource = {
  id: string          // 上传素材 id（ast_ 开头）
  name: string
  width: number | null
  height: number | null
  previewUrl: string  // /api/media/assets/<id>/file
}

type Asset = {
  id: string          // asst_ 开头
  kind: 'product' | 'avatar'
  name: string
  category: string
  status: 'draft' | 'generating' | 'ready' | 'partial' | 'failed'
  progress: { done: number; total: number }
  sources: AssetSource[]
  refs: AssetRef[]
  error: string
  free: boolean       // 这一套用的是新手免费额度
  createdAt: string
  updatedAt: string
}
```

### 槽位

| kind | slot | label |
|---|---|---|
| product | `hero` | 白底主图 |
| product | `scene` | 场景图 |
| product | `detail` | 细节特写 |
| product | `pack` | 成套平铺 |
| avatar | `front` | 正面定妆 |
| avatar | `half` | 半身景别 |
| avatar | `side` | 侧脸角度 |
| avatar | `action` | 场景中使用 |

### 接口

- `GET /api/assets?kind=product|avatar|all` → `{ ok, items: Asset[], limits: { product: 6, avatar: 3, sourcesProduct: 3, sourcesAvatar: 1, slots: 4, paidCreditsPerImage: 3 } }`
  （`paidCreditsPerImage` 由服务端按当前出图通道价下发，**别在界面里写死**；当前主通道 3 积分/张）
- `POST /api/assets` body `{ kind, name, category?, sourceAssetIds: string[] }` → `{ ok, asset }`（`status: 'draft'`，**不消耗积分、不调上游**）
- `POST /api/assets/:id/generate` → `{ ok, asset }` 立刻返回，`status: 'generating'`，后台逐张生成；每张按 `limits.paidCreditsPerImage` 扣（当前 3 积分），**新手首套（1 个产品 + 1 个数字人）免费**（返回的 `asset.free` 为 true，此时不扣积分，账本里不出现收费记录）
- `GET /api/assets/:id` → `{ ok, asset }`
- `PATCH /api/assets/:id` body `{ name?, category? }` → `{ ok, asset }`
- `DELETE /api/assets/:id` → `{ ok: true }`
- `GET /api/assets/:id/files/:slot` → 图片字节（登录 + 归属校验；别人的返回 404）

错误码：`ASSET_KIND`（kind 不合法）、`ASSET_NAME`（名字空 / 超 40 字）、`ASSET_SOURCES`（没有来源图或超数量）、`ASSET_LIMIT`（资产数超上限）、`ASSET_STATUS`（这一套正在生成 / 没有来源图不能生成）、`ASSET_CREDITS`（积分不足）、`ASSET_UPSTREAM`（生成失败，已退款）。

上传来源图**复用已有接口**：`POST /api/media/assets`（原始字节，非 multipart，见 src/api/media-gen.ts 的 `uploadMediaAsset`）。

## 三、前端要做的事

1. `src/api/assets.ts`：上面这些接口的客户端 + 类型（`Asset`、`OnboardingState`）
2. `src/components/OnboardingGate.tsx`：注册/首登后的引导弹窗。三步：身份 → 类目+方向 → 建资产（产品 / 数字人，上传图 → 生成 → 看到 4 张图）。
   - 只在 `session.user.kind === 'account'`（非管理员）且 `done === false` 时出现
   - 第一步不可关闭；全部走完写 `complete`
3. `src/pages/AssetsPage.tsx`：资产库（列表、新建、生成进度轮询、改名字、删除、点开看大图）
4. `src/nav.ts` + `src/domain/types.ts`：加 `assets` 页面（工具区，「我的资产」，`Package` 或 `Boxes` 图标）
5. `src/App.tsx`：路由 + 引导弹窗挂载点
6. `src/styles/assets.css`：样式（走 4/8 栅格与既有 token，不引 emoji、不用大面积渐变）

## 四、必须遵守的口径

- 资产图上要标「AI 生成」，不能让人以为是实拍。
- 生成中显示「第 N / 4 张 · 大概 20–90 秒一张」，失败要说清是哪一张、积分有没有退回。
- 没有来源图不能点生成（按钮禁用并说明「先上传 1–3 张商品图」）。
- 数字人资产这一版只是**定妆照参考图**，不做唇形驱动；界面上不要暗示能直接出说话视频。
