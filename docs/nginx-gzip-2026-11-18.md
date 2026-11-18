# 首屏 884KB → 346KB：nginx 把 JS 漏掉的那一个 MIME

2026-11-18，0.9.186（配置轮）。结论：**公网首屏传输量从 884KB 降到 346KB（−61%），其中 723KB 的 index.js 从裸传变成 212KB（3.4:1 压缩），首次内容渲染 532ms → 272ms**。根因不是「没开压缩」，而是 `gzip_types` 里少了一个 MIME。

## 一、怎么发现的

想给「手机上真的有人在用」这件事补一条性能基线，用无头 Chrome 按 390×844、禁用缓存打开登录页，读 `PerformanceResourceTiming` 的 `transferSize`：

| 资源 | 传输量 | 磁盘大小 |
| --- | --- | --- |
| `index-BmI9fsKN.js` | **723,465 B** | 723,465 B |
| `index-Cz9Og6Ux.css` | 72,269 B | 330,386 B |

CSS 330KB 只传了 72KB，说明压缩本身是开着的；JS 却一个字节都没少。对着 `nginx -T` 查：

```
gzip on;
gzip_types text/css application/javascript application/json image/svg+xml;
```

再看响应头：`Content-Type: text/javascript`。

**nginx 1.27 起 `mime.types` 把 `.js` 的 MIME 改成了 `text/javascript`**（以前是 `application/javascript`），而 `gzip_types` 里只有旧的 `application/javascript`——类型对不上就不压。这台机器是 nginx 1.30.2，于是 CSS 一直被压、唯一的入口 JS 一直裸传。因为「gzip on 是有的、CSS 也是压的」，从一个方向看完全正常，这个洞藏了很久。

## 二、改动

仓库模板 `deploy/production/nginx-app.conf` 与线上 `/etc/nginx/conf.d/visionqa.wavisionai.cn.app.inc`（渲染自同一份模板）同步改成：

```nginx
gzip on;
gzip_vary on;
gzip_comp_level 5;
# text/javascript 不能少：nginx 1.27 起把 .js 的 MIME 改成 text/javascript，
# 只写 application/javascript 时 CSS 压了、index.js 还是不压（2026-11-18 实测 723KB 裸传）。
gzip_types text/css text/javascript application/javascript application/json application/manifest+json image/svg+xml text/xml application/xml;
gzip_min_length 1024;
```

- `text/javascript`：这一轮的主角；
- `gzip_vary on`：原来是空的，没有 `Vary: Accept-Encoding`，中间层缓存有机会把压缩版发给不支持的客户端；
- `gzip_comp_level 5`：原来是默认的 1，CSS 从 72KB 进一步压到 52KB；
- `application/manifest+json`、`text/xml`：顺手补全文本类，避免下次又栽在同一个坑上。

线上改前留了备份 `/etc/nginx/conf.d/visionqa.wavisionai.cn.app.inc.bak-20261118-gzip`，`nginx -t` 通过后 `systemctl reload nginx`（不中断连接）。

## 三、防漂移

`scripts/check-nginx.mjs`（`npm test` 里跑）新增三条断言，把这次的教训钉住：

1. 必须有 `gzip on`；
2. `gzip_types` 必须同时含 `text/css`、`text/javascript`、`application/javascript`——少 `text/javascript` 时 nginx 1.27+ 的 `.js` 不会被压缩；
3. 必须有 `gzip_vary on`。

再配两条反向用例（`test/nginx-template.test.mjs` 从 18 条变 20 条）：把 `gzip` 改成 `off`、把 `text/javascript` 从类型表里删掉，检查器都必须报错。检查器永远绿才叫摆设。

## 四、验收（无头 Chrome，390×844，禁用缓存，登录页）

| 项 | 改前 | 改后 | 变化 |
| --- | --- | --- | --- |
| 首屏总传输 | 884,445 B | **346,247 B** | −538,198 B（−61%） |
| JS 合计 | 736,289 B | **218,322 B** | −70% |
| 其中 index.js | 723,765 B | **213,160 B** | 3.4:1 |
| CSS 合计 | 72,269 B | **52,045 B** | −28% |
| 首次内容渲染 | 532 ms | **272 ms** | −260 ms |
| DOMContentLoaded | 484 ms | **228 ms** | −256 ms |

另外三条服务端核对：

- 不带 `Accept-Encoding` 的客户端仍拿原文件：`new_js_plain=723465`（压缩不是强制的，老客户端不会拿到乱码）；
- 带 `If-None-Match` 的二次请求仍是 **304**，缓存语义没被压缩打乱；
- 响应头出现 `Content-Encoding: gzip` 与 `Vary: Accept-Encoding`，`Cache-Control: public, max-age=31536000, immutable` 未动。

浏览器侧健康检查（同一台机器，公网）：`document.title = VisionQA · Workbench`、登录表单在、8 个按钮、**0 条控制台异常 / 0 条加载失败**，只有一条预期内的 `/api/auth/me` 401。

## 五、边界

- 只改了 `visionqa.wavisionai.cn` 这一个 vhost；`canvas.wavisionai.cn`（无限画布，vite dev 反代）、演示站、别的站点没动；
- 同一台机器上 `redspeed.cn` 与 `wavisionai.cn` 的 `gzip_types` 里本来就有 `text/javascript`——说明这不是「全站都漏」，而是 VisionQA 这一份 vhost 从老版本模板渲染出来、一直没跟上；
- `visionqa.dionysusding.cn`（演示站，反代 3210）根本没有 `gzip_types`，只压 `text/html`；本轮没动，留作后续；
- 这台 nginx 没编 brotli 模块（`nginx -V` 里只有 `http_gzip_static`），所以走 gzip；要 brotli 得先换编译参数或装模块；
- `/api/` 的 JSON 本来就在 `gzip_types` 里、此前就已压缩，这一轮只是把压缩级别从 1 提到 5，没有新增对接口响应的压缩；
- 数字来自本机到这台服务器的公网链路（约 15–20ms RTT），换网络绝对值会变，比例不变；
- 本轮没有真实上游调用、没有花钱；产品界面没有变化，所以没有界面截图。
