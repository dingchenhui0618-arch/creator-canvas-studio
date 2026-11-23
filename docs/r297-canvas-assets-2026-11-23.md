# r297：画布素材与成片按账号隔离（2026-11-23）

r296 把画布 **JSON** 按账号隔离了，但明写了一条边界：画布里的素材与成片（`assets/outputs/downloads`）
仍是共享目录。用户接着就点了这条：**画布里的素材与成片也要按账号隔离**。

## 问题

`GET /api/workspace/file/<path>` 是画布所有图片/视频/音频的统一出口，它只做「路径不许出工作空间」，
**不认人**。拿一条真实路径打 5312：

```
anon = 200   # 没有任何 cookie，直接取到别人画布里的成片 mp4
```

也就是说，r296 之后画布清单、画布 JSON 都隔离了，但只要拿到一条文件 URL（历史链接、截图、
别人转发），仍然能下载别人的素材与成片。上传也落在全局 `uploads/`，同样不分账号。

## 修法（画布侧 server_v2.py）

1. **文件服务认人**：`/api/workspace/file/<path>` 先取 `_canvas_identity()`（httpOnly cookie
   `bd_canvas_session`，或 VisionQA 服务端带 `X-VQ-Canvas` 的 HMAC）。认不出人 → 401 `AUTH_REQUIRED`。
2. **按目录定归属**：
   - `canvases/<目录>/…` → 目录里的 `.canvas_id` 找到画布 JSON，读 `_owner`；
   - `uploads/<账号目录>/…` → 目录里的 `.owner` 标记（新上传按账号分子目录，上传时写入）；
   - 其余（`outputs`、`assets`、`downloads`、`projects`、老 `uploads/` 根下）→ 共享区，登录即可看。
3. **越权一律 403 `FILE_FOREIGN`**；画布目录认不出归属（无 `.canvas_id`、画布 JSON 已删）→ **只给管理员**，
   宁可拒绝也不放出去。管理员与服务身份（VisionQA 服务端）照旧可以拿全部。

只改 `server_v2.py` 一个文件（+55 / −2），没有改画布前端、没有改 VisionQA。

## 验收（生产，真实请求）

| 请求 | 5312 直连 | 6677（vite dev 代理） |
| --- | --- | --- |
| 无凭据取管理员画布的成片 | 401 | 401 |
| 管理员 cookie | 200 | 200 |
| mark cookie | 403 | 403 |
| 共享区 `assets/saved/a.png`（mark） | 200 | 200 |

- mark 的 `/api/canvas/list` 仍是 `{"canvases":[]}`，管理员 5 块，与 r296 一致。
- VisionQA 侧 `/api/bdc/canvases`（服务端带 HMAC 调画布）仍回 5 块，状态 200——服务身份没被拦。
- `bdc-api` restart 后 active，`/api/health` 200。

## 边界（这轮没做，需要时再开口）

- `assets/saved`（画布「素材库」）、`projects/`、`autosave/`、老 `uploads/` 根下仍是共享区：
  里面可能有别人的图。要做成按账号，得先决定旧文件怎么迁（老 URL 还写在别人的画布节点里）。
- `/api/workspace/canvas-files`、`resolve-files` 这类**列目录**接口没有按归属过滤：能列出文件名，
  但文件本身已经被 403 拦住。
- 画布自己的企业超管（部署方账号）仍看全部，这是画布产品的后台口径，不是 VisionQA 用户。

## 回滚

- 代码：`/var/backups/bdcanvas/server_v2.py.pre-r297b-*.py`（打补丁前那份），覆盖回去 restart `bdc-api`。
- git：`/opt/bdcanvas` 分支 `prod-rebrand-20261118`，提交 `af63c9f`（本地，未推远端）。
