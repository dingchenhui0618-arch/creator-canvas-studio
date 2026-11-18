# 画布合并上线 + 生视频窗口的真 bug（2026-11-18）

用户 2026-11-18 早上给了三条授权：MFA 动态码（短信通道）、画布合并选 **A**、同意生图 9:16/16:9 与视频 8s/720p 真调。这一篇记画布与真调，短信那条另见 `sms-console-2026-11-17.md`。

## 一、画布合并（选 A）：/opt/bdcanvas 从 f1edd9d 前进到 c5eaa1e

生产画布的现场和「干净的 git 仓库」差得很远：`/opt/bdcanvas` 在 `f1edd9d` 上有 **14 个已跟踪文件被改**（`vq-theme.css`、`visionqa-align.css`、`db.py`、`models.py`、`generation_*.py`、`enterprise.db` 等）和 **23 个未跟踪文件**（各种 `.bak-r175b`、`.venv`、`public/vq-theme.css`）。这些是 r175 之后在服务器上直接改的东西，没有任何提交。

所以没敢直接 merge，按「先备份、再让工作区干净、再前进、再把改动放回来」四步走：

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 1. 整树备份 | `tar czf /var/backups/bdcanvas-premerge-.tgz --exclude=node_modules --exclude=.venv -C /opt bdcanvas` | 35 MB，落在 `/var/backups` |
| 2. 生产改动收进 stash | `git stash push -u -m pre-merge-snapshot` | `stash@{0}`，工作区干净（37 项） |
| 3. 前进到合并候选 | `git fetch /tmp/bdcanvas-merge merge-r175:candidate` → `git merge --ff-only candidate` | **fast-forward 成功**，HEAD = `c5eaa1e`（远端 11-09 的 8 个提交 + r175 + vite banner 修复） |
| 4. 生产改动放回来 | `git stash pop` | 只有 **1 个冲突**：`src/features/startup/runtimeMode.ts` |

**冲突的真相**：不是两边逻辑不同，而是上游把 `TRUSTED_HOSTS` 那段声明**重复贴了一遍**（第 8–16 行已经有了，冲突块里又有一份）。处理方式是删掉重复块、保留生产侧的写法（`sed -n '1,16p;43,55p'` 重新拼这个文件），文件从 56 行变 43 行，`isPublicWebClient` / `isPublicRequestHost` 两个函数逻辑一字未改。

`git diff f1edd9d c5eaa1e --stat`：`.gitignore`、`enterprise.ts`（1652 行）、`runtimeMode.ts`、两个 vite 配置、`vq-theme.css`（新增 912 行）。**package.json / lock 没动**，所以不需要重装依赖，生产仍是 vite dev（不跑 build）。

重启三个服务后自检：

| 检查 | 结果 |
| --- | --- |
| `bdc-web`（6677，vite dev） | active，`/` 200，日志 `VITE v5.4.21 ready in 1372 ms` |
| `bdc-api`（5312） | active，`/api/health` 200 |
| `bdc-enterprise`（5313 Flask） | active，`/` 302（跳登录），无 500 |
| 浏览器真实加载 `https://canvas.wavisionai.cn/` | 标题 `默认画布 * - VisionQA Canvas`，Beta `0.7.5.7`，**没有 vite 错误浮层** |

> 回滚：`cd /opt/bdcanvas && git reset --hard f1edd9d && git stash pop`，或直接解 `/var/backups/bdcanvas-premerge-.tgz` 覆盖回去。

## 二、真调暴露的真 bug：生视频窗口从上线起就没成功过

按授权调 8s/720p，4 秒就失败：`出视频失败：上游拒绝了这次生成（HTTP 400 validation_error）`。拿 Key 池里的 Key 直接对上游发同一份 body 探针，原文是：

```json
{"error":{"code":"validation_error","message":"aspect_ratio is required.","type":"invalid_request_error"}}
```

也就是说 **SeeAPI 的出视频接口强制要 `aspect_ratio`，而我们的 `server/routes/media-gen.mjs` 从来没传这个字段**——智能体页的生视频窗口没有比例控件，请求体里也就没有比例，于是每次都在几秒内被上游拒掉、退款。真调一次就把它抓出来了，之前的单元测试抓不到，因为假上游不校验这个字段。

修法（最小改动）：

1. `media-gen.mjs`：新增 `VIDEO_RATIOS = 9:16 / 16:9 / 1:1`，默认 `9:16`（界面本来就把生视频标成竖屏）；`validateBody` 校验 `ratio`，`runVideo` 把 `aspect_ratio` 传给 `createVideoTask`。
2. `test/media-gen.test.mjs`：**假上游也按真实上游的规矩办事**——POST 里没有 `aspect_ratio` 就回 400 `validation_error`。这样「忘了传比例」这种 bug 在单测里就会红。另外加一条用例：显式给 `16:9` 要原样透传，给 `4:3` 要 400 且不扣积分。

### 真调结果（0.9.175，生产，mark 账号）

| 用例 | 结果 | 耗时 | 文件 | 积分 |
| --- | --- | --- | --- | --- |
| 生图 9:16（1024×1536） | **成功** | 81.3 s | PNG 2,066,905 B | 5 |
| 生图 16:9（1536×1024）第一次 | 失败（上游超时，网关 120 s 到点） | 124 s | — | 5，**已退** |
| 生图 16:9 第二次 | **成功** | 26.8 s | PNG 2,075,773 B | 5 |
| 生视频 8s / 720p | **成功** | 184.5 s | MP4 3,009,531 B | 15 |

出图那条超时是上游（GeteAPI）不稳，不是我们的 bug：同一条请求重发 26.8 秒就回来了。但**一连串失败会把唯一那把出图 Key 打进 60 秒冷却**，界面这时显示的是「平台还没接入出图模型，请联系管理员补一把出图 Key」——事实上 Key 在池子里、只是刚被上游打回来，这条提示会把管理员带偏。记进待办：冷却中应该提示「上游刚失败，冷却 N 秒后再试」。

## 三、部署

- 版本 `0.9.175`，入口 `index-Dz2cpipN.js`，`/api/health` ok templates 26；
- 快照 `/opt/visionqa/releases/20261118-013458-v0.9.175video.tar.gz`（`ops/rollback.sh --to 1` 回 0.9.174）；
- 本轮真调花费：出图成功 2 次（约 $0.096）、上游超时 1 次、视频 1 条（按 SeeAPI 标价按秒计）；积分侧 mark 账号共扣 25（5+5+15），失败那次已退。

## 四、门禁

| 门禁 | 结果 |
| --- | --- |
| 全量测试 | **1334 / 1334 通过**（比上一轮 +1：视频比例透传用例） |
| lint | 0 error / 16 warning |
| `npx tsc -b` | 干净 |
| 密钥扫描 | 828 个文件无命中 |
| 画布 | 三服务 active、6677/5312 200、浏览器无报错 |

## 五、边界

- 画布合并走的是 **fast-forward + stash pop**，不是一次真正的 merge 提交：`c5eaa1e` 本身是干净的合并候选，生产侧的改动仍在工作区（未提交），所以「生产树 = 合并候选 + 未提交改动」这个事实要记住；下次再动画布先 `git status`。
- `git ls-remote origin` 在这台机器上用 token 拉 GitHub 时偶发 `Failure when receiving data from the peer`，这次靠 `/tmp/bdcanvas-merge` 本地仓库 fetch，不依赖网络。
- 生视频只真调过 `seedance-2.0 / 8s / 720p / 9:16` 这一种组合，16:9 与 1:1 没真调；480p 也没在这一版再测。
- 出图超时那次，上游是否计费无法从本地确认（GeteAPI 后台为准）。
