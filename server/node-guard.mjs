// 守门模块：必须是 server/index.mjs 的第一个 import。
//
// ESM 按 import 声明顺序求值，所以它在 config / storage / SQLite 之前跑：
// 版本不对、或者启动时漏了 --experimental-sqlite，都在这里给一句能看懂的错，
// 而不是让 node:sqlite 抛一个 ERR_UNKNOWN_BUILTIN_MODULE 的裸栈。
import { assertSupportedNode } from './node-version.mjs'

assertSupportedNode()

// 动态 import 才接得住：静态 import 失败会直接终止模块求值，catch 不到。
try {
  await import('node:sqlite')
} catch (cause) {
  console.error('[node] Node ' + process.versions.node + ' 现在用不了 node:sqlite：' + (cause && cause.message ? cause.message : cause))
  console.error('[node] Node 22 启动时要带 --experimental-sqlite；检查 systemd 单元的 ExecStart。')
  process.exit(78)
}
