# r285：把「写不进去就当没发生」这个坑一次堵完（v0.9.267）

日期：2026-11-20 ｜ 前置：r284 / v0.9.266

## 一句话

r284 抓到的那次 `EPERM rename` 不是 media-gen 一家的事：全站 **47 处「写 .tmp 再 rename」**都是同一个坑，
这一轮全部收到 `server/atomic-write.mjs` 上，并加了一条守卫测试——以后谁再手写 rename，门禁直接红。

## 为什么值得占一轮

r284 的现场：任务元数据写终态时 rename 撞上「作品流每 2.5 秒轮询同一个任务文件」，Windows 返回 `EPERM`，
那一次写失败 → 任务永远停在「进行中」→ 用户白扣积分、看不到结果，**结果与退款一起丢**。

同样的写法在 40 个文件里各抄了一遍，而且深浅不一：

| 写法 | 谁在用 | 撞上被占用时 |
| --- | --- | --- |
| `await fsp.writeFile(tmp) + await fsp.rename(tmp, target)` | 27 个文件（作品、模板、评审、运行记录、告警、系统配置…） | 直接抛，这一次修改没了 |
| 同上 + 自己写的 3 次重试 | 只有 `projects.mjs`（r267 手工补的） | 好一点，但还漏 `EAGAIN` |
| `fs.writeFileSync(tmp) + fs.renameSync(tmp, target)` | 13 个文件（偏好、配额、价格、Key、画布归属、计费订单…） | 直接抛，同步路径连 catch 都没有 |

最难看的一处：`keyvault.mjs` 存 Key 状态，撞上就是「这把 Key 的启用/停用没生效」，界面刷新后又变回去——
用户会以为是自己点错了。

## 改了什么

1. `server/atomic-write.mjs` 补同步形态：`renameSyncWithRetry` / `writeFileAtomicSync`。
   同步代码里没有 await，等待用 `Atomics.wait`（Node 主线程允许，浏览器不允许），每次等
   `min(delayMs*(attempt+1), 200)` 毫秒——**故意封顶**，不能因为一次写重试把请求线程按住好几秒。
2. 30 处异步 + 1 处（`projects.mjs` 手写重试）+ 16 处同步全部换成 helper，**行为与文件权限逐处对齐**：
   - 原来 `writeFile(tmp, x, 'utf8')`（默认 0644）的，现在显式传 `{ mode: 0o666 }`，umask 后仍是 0644；
   - 原来显式 `0o600` / `0o666` 的照传；
   - 原来 rename 后补 `chmod` 的（邮件、短信、站点、余额、搜索、上游 Key）保持不动。
3. `agents.mjs` 的「把坏文件挪去 .broken-<时间戳>」也走 `renameWithRetry`：
   挪不走才降级成「不许写」，别把一次瞬时占用当成「原件已经动了」。
4. 新增守卫 `test/atomic-write-guard.test.mjs`：`server/` 递归扫一遍，除 `atomic-write.mjs` 外
   出现 `renameSync(` 或 `.rename(` 即失败；确需自己动 rename 的（例如以后把文件挪进回收站），
   在那一行写 `// atomic-write-exempt: 原因` 显式放行，review 时说清。

## 语义边界（没变，也必须说清）

- 只重试 **EPERM / EBUSY / EACCES / EAGAIN** 四个「等一会儿可能就行」的错误码，最多 6 次，间隔逐次加长；
  `ENOSPC`（盘满）、`ENOENT`（路径没了）、`EINVAL` 这类立刻抛，**不装成写成功**。
- 抛之前一定删掉自己的 `.tmp`，不在数据目录里留看不出是什么的碎片。
- 还是「先写临时文件再 rename」：读的一方要么看到旧版本、要么看到新版本，永远读不到半份 JSON。
- 同步版会**阻塞**事件循环最多约 375ms（6 次 × 递增等待，单次封顶 200ms），只发生在真的撞上占用时；
  正常路径（rename 一次成功）与之前完全一样，没有额外系统调用。

## 门禁与实测

- 测试 **1913/1913**（在 r284 的 1906 条上新增 7 条：同步版写入/重试/放弃/不重试 4 条 + 守卫 3 条）。
- `npx oxlint src test server scripts`：**0 error / 24 warning**（658 文件，与 r284 同档）。
- `npx tsc -b` 干净；`node --check` 扫过 `server/` 全部模块；
- `npm run build` 通过，入口 `index-CQ-R63kV.js`（783,236 B）、样式 `index-C8L3wwQQ.css`（368,412 B）、dist 46 个文件。
- 守卫测试做过反向验证：在 `server/preferences.mjs` 里临时加回一行 `fs.renameSync(tmp, file)`，守卫立刻失败并点名
  「preferences.mjs:NN fs.renameSync(tmp, file)」（见下），删掉后恢复全绿（该改动未提交）。

## 边界

- 这轮**没有任何真实上游调用**（0 次出图/出视频/文本），0 费用。
- 守卫只管 `server/`；`scripts/` 里的一次性运维脚本不在其列（它们不跑在服务进程里）。
- 同步版的重试只证明能扛住「暂时性 rename 冲突」；盘满、权限错、杀毒软件长期锁文件照样当场报错。
- 覆盖的是**写盘这一环**：如果进程在 rename 成功后、返回给用户之前崩掉，界面仍可能显示旧状态（下次刷新才对）。
