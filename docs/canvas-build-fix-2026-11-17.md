# 画布生产构建为什么一直失败（2026-11-17）

结论先行：`npm run build` 一直挂在 `[object Object]` 上，根因不在业务代码，而是 **`vite.config.ts` 把 `output.banner` 写成了对象**。vite 5 / rollup 4 的 banner 只接受字符串，对象被 `String()` 成字段名一样的字面量 `[object Object]` 拼到每个 chunk 第一行，esbuild 转译时报语法错。改成「js 交回 rollup + css 用插件补」之后构建通过。

## 一、现场

```
[vite:esbuild-transpile] Transform failed with 1 error:
assets/VideoFaceBlurEditor-!~{002}~.js:1:8: ERROR: Expected "]" but found "Object"
1  |  [object Object]
2  |  import { _ as __vitePreload, D as DEFAULT_MASK_CONFIG, r as renderIcon } from './index-!~{001}~.js';
```

前一行 `1 | [object Object]` 就是被当代码塞进去的 banner，第 8 列正好是第二个 `Object`。

## 二、根因

```ts
// 改之前的 vite.config.ts / vite.build.config.ts
build: {
  rollupOptions: {
    output: {
      banner: {
        js: `/*! ... js-bundle-ai-canvas-pro-0.7.5-7 */`,
        css: `/*! ... css-bundle-ai-canvas-pro-0.7.5-7 */`,
      },
    },
  },
}
```

`{ js, css }` 这种写法是打包器扩展出来的约定，rollup 4 不认：它拿到对象直接当字符串用，于是每个 chunk 开头都多了一行 `[object Object]`，紧接着才是真代码和 `import`，esbuild 解析失败，整次构建在 23.6s 处中断（2262 个模块已经转译完）。

## 三、影响面

| 基线 | HEAD | 修复前 `vite build` |
| --- | --- | --- |
| 远端 master | `2d30d7f` | 失败（同一个报错） |
| 生产画布用的 r175 | `f1edd9d` | 失败（同一个报错） |
| 合并候选 r175-merged | `5dfb2b2` | 失败（同一个报错） |

所以这不是合并引入的、也不是 r175 引入的；**生产画布跑的是 `vite dev`（6677 端口），dev 不走 banner 这段，所以线上一直没暴露**。这也是为什么之前几轮看见 prod 正常却从来没构建出过 `dist`。

## 四、改法

两个配置文件（`vite.config.ts` 与 `vite.build.config.ts`）同样处理：

1. 两段 banner 文本原样提成模块级常量 `BUNDLE_BANNER_JS` / `BUNDLE_BANNER_CSS`——**文本一个字没改**，`BDCanvas-Forensic-Banner: js-bundle-ai-canvas-pro-0.7.5-7` 与 `css-bundle-ai-canvas-pro-0.7.5-7` 两条 forensic 标记都还在。
2. `output.banner` 只传字符串 `BUNDLE_BANNER_JS`，交给 rollup 正常前置到每个 js chunk。
3. 新增本地插件 `canvas-css-banner`：`generateBundle` 里给每个 `.css` 资源的 `source` 前面拼上 `BUNDLE_BANNER_CSS`，补上 rollup 不负责的样式表 banner。

只动了 banner 这一段，没有改业务代码、没有改版本号、没有动 `dist/` 与 `frontend-dist/`。

## 五、验证

- `npx vite build`：**成功**，2262 modules，28.09s / 28.65s，产物 `index-CHzeK0wR.js` 2.22 MB、`human.esm-BVRUPnM_.js` 1.58 MB、`VideoFaceBlurEditor-DGSz7ByS.js` 53 KB、`index-DaK5dAbd.css` 218 KB。
- 整条 `npm run build`（`tsc` + `vite build` + `node scripts/stage-frontend-dist.js`）：`tsc` 0 报错，`[frontend dist staged]` 正常输出。
- 标记核实：3 个 js chunk **全部**带 `BDCanvas-Forensic-Banner: js-`，1 个 css 带 `css-`；chunk 首行是真代码，不再是 `[object Object]`。
- 同一个修复在 `upstream-master`（`2d30d7f`）上单独 cherry-pick 后同样构建通过（28.65s），说明修复与 r175 那批改动无关。
- 产物冒烟：`npx vite preview --port 6688` 起本地静态服务后，`GET /` 返回 **200**、`GET /assets/index-CHzeK0wR.js` 也 **200** —— 构建产物不是只「能编译」，是能被浏览器加载的成品（预览进程测完已 kill，没碰生产）。

## 六、分支与上线

推的是两个**新增分支**，`master` 与生产目录都没动：

| 分支 | HEAD | 内容 |
| --- | --- | --- |
| `r175-merged` | `c5eaa1e` | 合并远端 8 个 11-09 提交 + r175 GPT-Image 出图 + 本构建修复 |
| `fix-vite-banner` | `28192a6` | 只含构建修复（基于 `upstream-master 2d30d7f`），可单独合进 master |

生产画布 `/opt/bdcanvas` 仍是 `f1edd9d`、仍以 `vite dev` 跑，本轮没有重启、没有换代码。

## 七、边界

- 只验证了「能构建、且能用本地静态服务打开」；**没有把构建产物替换到生产**——生产换不换 `dist` 是另一个决定（要停 dev server 改静态托管），需要你点头。
- 3 个 chunk 仍超过 500 kB 的告警是原有体量问题（`index` 2.2 MB、`human.esm` 1.58 MB），这次没有做拆包。
- 画布仓库自己的 `check:release-version-sync` 等发布检查没有跑，也没改 CHANGELOG 与版本号——这次只修构建配置。
