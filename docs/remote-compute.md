# 远端算力：把「一键复刻」的抽帧交出去

本地跑 ffmpeg 有两个问题：占 CPU、占内存。这条链路把 **解析 → 下载 → 探测 → 抽帧** 整体挪到另一个服务上，
工作台只负责「收帧 → 调视觉模型 → 入库」，服务器上不再需要跑 ffmpeg。

## 开关

```bash
# 不填就还是本地 ffmpeg（默认）
REPLICATE_REMOTE_URL=http://127.0.0.1:8790/replicate
REPLICATE_REMOTE_TOKEN=<可选，双方约定的 Bearer token>
REPLICATE_REMOTE_LABEL=remote-worker
REPLICATE_REMOTE_TIMEOUT_MS=180000
```

填了 `REPLICATE_REMOTE_URL` 之后，`server/jobs.mjs` 走远端分支：日志里会出现
`调用远端算力（…）`、`远端算力 … 返回 N 帧`、`来源：远端算力 …`。没填就走原来的本地链路，
行为与现在完全一致。

## 契约（HTTP）

```
POST <REPLICATE_REMOTE_URL>
Authorization: Bearer <token>          # 只在配置了 token 时要求
Content-Type: application/json

{ "url": "https://.../video.mp4", "maxFrames": 18 }

200 OK
{
  "ok": true,
  "meta": { "duration": 10.0, "width": 640, "height": 360, "fps": 30, "codec": "h264" },
  "cuts": [0, 1.8, 4.2],              // 场景切点（秒），可为空数组
  "frames": [                          // 按时间升序，1..maxFrames 张
    { "t": 0,   "base64": "<jpeg base64>" },
    { "t": 2.2, "base64": "<jpeg base64>" }
  ],
  "tookMs": 993
}
```

失败返回非 200 或 `{ "ok": false, "error": "…" }`；工作台会把错误写进任务日志，并在还有备用链接时继续尝试下一条。

帧的约定：JPEG、宽 480px、按时间升序、`t` 为秒。工作台会按顺序存成 `frame-01.jpg` 等文件，
后面的视觉分析与模板入库完全复用现有实现。

## 参考实现

仓库自带 `worker/video-worker.mjs`，就是上面契约的最小服务：

```bash
WORKER_PORT=8790 WORKER_TOKEN=dev node worker/video-worker.mjs
curl -s http://127.0.0.1:8790/health
```

- 支持 `http(s)` 与 `file://` 两种来源，超时与大小都有限制（默认 200MB / 120s）；
- 抽帧用的是同一份 `server/frames.mjs`（一次解码出全部帧 + 关键帧预筛场景切点）；
- 它可以直接跑在**另一台机器**上：工作台只连它，不需要给对方任何 ssh 权限。

## 换成云厂商

工作台只认上面这个 JSON 契约，所以把云厂商的媒体处理（阿里云 MPS、腾讯云数据万象、火山引擎）
包一层适配器即可，适配器负责：提交截图任务 → 轮询/等回调 → 把结果转成 `frames[]`。
注意两件事：

1. 云厂商通常要求源文件在自家对象存储里，或者能直连拉取；带防盗链的短视频直链常常拉不动，
   这时仍然需要一个「下载」环节（放在 worker 上更稳）。
2. 出网带宽比 CPU 便宜得多：把 100MB 视频上传到云端，在 5Mbps 下要 3 分钟，
   而本地解码同一条视频只要 20 秒。所以「云端抽帧」只有在 worker 就近、或源文件本来就在云上时才划算。

## 实测

本机跑通一次（worker 与工作台同机，仅验证链路）：

| 环节 | 耗时 |
| --- | --- |
| 远端：下载 + 探测 + 切点 + 抽 5 帧 | **0.8s** |
| 工作台：收帧 + 落盘 | < 0.1s |
| 视觉模型（5 帧，第三条 fallback 才成功） | 40s |

整条任务 45.5s 完成并入库，工作台进程全程没有启动 ffmpeg。
