# 无限画布：GPT-Image 出图通道（v0.9.165，2026-11-16）

无限画布是第三方应用（BD Canvas，自用授权），源码与数据库都在服务器 `/opt/bdcanvas`，不在本仓库。
这里只记录我们为它做的接线、数据与回滚，便于升级 / 迁移后照着恢复。**不要**把它的源码复制进本仓库。

## 改了什么

| 位置 | 改动 |
| --- | --- |
| `src/features/generate/modelCatalog.ts` | 新增 `gpt-image-2`（GPT Image 2）与 `gpt-image-2.5`（GPT Image 2.5）；隐藏 CGCM 图片模型；旧图片模型别名表 `LEGACY_IMAGE_MODEL_ALIASES` → `gpt-image-2` |
| `src/features/generate/generate.ts` | 新分支：图片节点 → `POST /enterprise/api/generate/gpt-image`；尺寸按比例映射到 1024×1024 / 1536×1024 / 1024×1536 |
| `src/main.ts` | 加载画布时把旧 CGCM 图片节点迁到 `gpt-image-2`（视频节点跳过），迁移后自动保存 |
| `src/features/generate/enterpriseModelVisibility.ts` | 授权身份表加两个 GPT 图片模型（否则会被过滤掉） |
| `enterprise_server/generation_gpt_image.py`（新） | 新端点：读 `BD_GPT_IMAGE_BASE_URL`（默认 `http://127.0.0.1:8799/api/gateway`），带平台网关令牌请求 `/v1/images/generations`；接受 `url` 或 `b64_json`；走既有 media backup 落盘；写 `generation_records` |
| `enterprise_server/app.py` / `auth.py` | 注册路由；默认授权表加 gpt-image 两条；公开注册不再发 CGCM 图片模型 |

## 数据（`enterprise_server/data/enterprise.db`）

- `enterprise_api_keys`：新增 `provider='gpt-image'`，`gateway_url=http://127.0.0.1:8799/api/gateway`，`key_ciphertext` 与原有 CGCM 网关 Key 相同（同一枚平台令牌）。
- `pricing_rules`：`gpt-image-2` / `gpt-image-2.5`，`fixed_per_call`、CNY、`fixed_price_li=440`（¥0.44 / 张；上游 $0.06）。
- `user_model_assignments`：每个启用账号两条 gpt-image 授权；12 行 CGCM 图片授权 `is_enabled=0`；`cgcm-seedance` 视频授权不动。
- `system_settings`：`gpt_image_channel_v1=applied`（迁移标记）。

## 验证

真实出图会花上游额度，日常自检只用本地 stub：

1. 起一个 stub（127.0.0.1:8788），返回 `{"created":1,"data":[{"b64_json":"data:image/png;base64,<tiny png>"}]}`。
2. 临时把 `BD_GPT_IMAGE_BASE_URL` 指向 stub，重启 `bdc-enterprise`。
3. 画布上选 GPT Image 2 出一次图：`generation_records` 应有 `provider=gpt-image`、`status=succeeded`、`actual_charge_li=440`，且媒体目录有落盘文件。
4. 恢复 env 默认值并重启；stub 停掉。

## 提交与备份

- 本次改动已在 `/opt/bdcanvas` 本地提交：`8eb11c7 VisionQA r175: GPT-Image 出图通道上线，CGCM 图片模型下线`（未 push）。
  该提交同时带上了当时工作区里既有的未提交改动（企业信任 / 积分显示等），它们本来就在生产里跑，
  一起提交是为了把线上状态固定在 git 里；要精确撤本次改动，仍按下面按 `.bak-r175*` 回滚。
- `pricing_rules` 里 `seeapi-seedream-5.0-pro` 的 3 条（1K/2K/4K）保留 `is_active=1`：模型已不可选、授权也停了，
  价格记录留作历史与将来恢复用。

## 回滚

代码（备份名 `*.bak-r175-<时间戳>`）：

```bash
cd /opt/bdcanvas
TS=$(cat /tmp/r175-ts)   # 动手时记下的时间戳
for f in enterprise_server/app.py enterprise_server/auth.py \
  src/features/generate/modelCatalog.ts src/features/generate/generate.ts \
  src/features/generate/enterpriseModelVisibility.ts src/features/node-defaults/store.ts \
  src/main.ts; do cp "$f.bak-r175-$TS" "$f"; done
rm -f enterprise_server/generation_gpt_image.py
systemctl restart bdc-enterprise
```

数据库最小回滚：

```sql
delete from enterprise_api_keys where provider='gpt-image';
delete from pricing_rules where provider='gpt-image';
delete from user_model_assignments where provider='gpt-image';
update user_model_assignments set is_enabled=1 where provider in ('cgcm-image2','cgcm-nano-banana','seeapi');
delete from system_settings where key='gpt_image_channel_v1';
```

整库回滚用动手前的快照 `/tmp/r175/enterprise.db.bak-r175`（迁移前），复制回 `enterprise_server/data/enterprise.db` 后重启。
