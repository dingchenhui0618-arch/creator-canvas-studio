# 16:9 出视频走我们自己的网关真调通过（2026-11-18，版本仍 0.9.177）

**结论**：授权范围内最后一条没验过的组合跑通了——智能体页选 **16:9** → 平台网关 → SeeAPI `seedance-2.0` → **1280×720 / H.264 / 8.1 秒 / 2.9 MB** 的 mp4，317 秒出片，扣 15 积分且未退款。至此生视频三档比例里 9:16 与 16:9 都有真实产物；1:1 仍未真调。

![16:9 出视频 · 第 2 秒帧（1280×720）](video-16x9-frame-720p.png)

## 一、为什么单独跑这一条

r190 真调只覆盖了 `9:16`（那时是唯一能出片的比例），r191 才把比例做成界面上的三档。当时的边界写得很清楚：**单测只证明我们发出去的 body 里 `aspect_ratio` 对不对，证明不了上游真接受、真出横屏片**。而这条链路上一次就栽在这里——漏传 `aspect_ratio`，单测全绿、真调 4 秒被拒。所以「界面选横屏 → 网关 → 上游 → 落盘 → 能播」必须真花钱走一遍。

## 二、怎么跑的（不靠人工点界面）

新增 `scripts/media-verify-once.mjs`。它做的事和界面点一下完全一样，只是可复现：

| 步骤 | 做什么 |
| --- | --- |
| 取会话 | 只按 **user id** 找账号（不传手机号 / 邮箱），签一个临时会话，跑完 `destroySession` 撤销 |
| 下单 | `POST /api/media/generate`，body 就是界面发给服务端的同一份 |
| 等 | 每 5 秒轮询 `GET /api/media/tasks/<id>`（这一步驱动服务端去问上游） |
| 取片 | `GET /api/media/tasks/<id>/file` 下载到本地，认证走同一个 cookie |
| 量 | 先试 `ffprobe`，没有就自己读容器头：MP4 的 `tkhd` 宽高（16.16 定点）+ `mvhd` 的 timescale/duration |

生产机没有 ffmpeg（`which ffprobe` 查不到），所以写完文件后由 `probeHeader()` 读文件头给宽高与时长——脚本因此不依赖任何外部工具。命令：

```bash
sudo -u visionqa env DATA_DIR=/var/lib/visionqa node --experimental-sqlite \
  scripts/media-verify-once.mjs --user usr_xxx --kind video --ratio 16:9 \
  --duration 8 --resolution 720p --out /tmp/v16x9.mp4
```

脚本必须显式给 `--kind`，没有「顺手跑一遍」的默认值——它会真扣积分、真花钱。

## 三、结果

| 项 | 值 |
| --- | --- |
| 请求 | `kind=video`、`ratio=16:9`、`duration=8`、`resolution=720p` |
| 任务 | `status=processing` → `succeeded`，`ratio_echo=16:9`（服务端确实把比例透传并回了显） |
| 文件 | `video/mp4`，**2,895,736 B**，`ftyp isom`，`avc1`（H.264），**1280×720**，**8.10 s** |
| 耗时 | **317 s**（对比 9:16 那次 184.5 s） |
| 积分 | `cost=15`，`refunded=false`，余额 1075 → 1060 |
| 播放性 | Chrome 里 `readyState=4`（HAVE_ENOUGH_DATA）、`videoWidth×videoHeight=1280×720`，能解码到 8.1 秒 |

事件线：

```text
START kind=video model_ratio=16:9 duration=8s resolution=720p
TASK id=mgen_vS0Tga6zhoUC status=processing cost=15 balance=1060 model=seedance-2.0 ratio_echo=16:9
POLL progress=0% warning=
POLL progress=100% warning=
RESULT status=succeeded elapsed=317s credits=15 refunded=false bytes=2895736 mime=video/mp4
       dims=1280x720 dur=8.1s via=header out=/tmp/v16x9.mp4
SESSION revoked
```

## 四、踩到的一个坑（值得记）

截「第 2 秒帧」时前两次都是**黑图**，`videoWidth` 一直是 0、`readyState=0`、`networkState=2`。原因不是编解码也不是服务：**Chrome 的后台标签页不加载媒体**。WebBridge 新开的标签是隐藏的（`document.visibilityState === 'hidden'`），必须先 `Page.bringToFront`（WebBridge 回 `activation: focus-emulation`，即不抢用户焦点地把它算作可见），媒体才开始解码，随后 `readyState` 直接到 4。

顺带一条：「接口返回 200 就没问题」在这里不成立——同一份 mp4 用 `curl` 单拉 2.9 MB 正常，但视频元素自己不拉，任何探针只能看到 0×0。

## 五、这一轮花了多少

| 项 | 花费 | 依据 |
| --- | --- | --- |
| 生视频 1 条（8s / 720p / 16:9） | 约 **¥1.4** | SeeAPI `seedance-2.0` 按秒计价，见后台「模型与上游」 |
| 出图 | 0 次 | 本轮没跑 |
| 合计 | 约 ¥1.4 | 属用户 2026-11-18「同意生图 9:16/16:9 与视频 8s/720p 真调」的授权范围 |

## 六、门禁

| 门禁 | 结果 |
| --- | --- |
| 全量测试 | 1342 / 1342 通过 |
| lint | 0 error / 16 warning |
| `npx tsc -b` | 干净 |
| 密钥扫描 | 837 个文件无命中 |

## 七、边界（别把这条读多了）

- **1:1 出视频仍未真调**；`480p` 这一版也没再测。三档比例只覆盖两档。
- 317 s 与 184.5 s 的差别只能说明上游排队有波动，**不能**据此说 16:9 更慢。
- 内容正确性只看了第 2 秒一帧（橘猫在窗台伸懒腰，横构图、光比正常），没有逐帧核对。
- 宽高与时长是读容器头得来的，没有解码校验码流完整性；但 Chrome 能解到 8.1 秒且画面正常，说明整条能播。
- 脚本打的是**生产上面向真实账号的接口**，跑一次真扣积分真花钱，别拿它当冒烟测试。

## 八、下一步

1. 1:1 生视频（约 ¥1.4）与 480p 是否要验——等用户点头。
2. 10 条历史未确认告警要不要标已确认。
3. 短信签名报备中（运营商 5–7 工作日），赠送签名期间个别运营商可能收不到。
