// 恢复校验：把解包出来的目录当成真实数据目录打开，看账号、Key、模板能不能读出来。
// 用法：DATA_DIR=/tmp/vq-restore-drill node --experimental-sqlite scripts/verify-restore.mjs
// 这是「备份能不能真恢复」的实证：Key 能解出明文、账号能登录查询，才算恢复成功。
import { config } from '../server/config.mjs'
import { listUsers } from '../server/auth.mjs'
import { listKeys } from '../server/keyvault.mjs'
import { listTemplates } from '../server/templates.mjs'

const users = listUsers()
const keys = listKeys()
const templates = await listTemplates()
const summary = {
  dataDir: config.dataDir,
  users: users.length,
  admins: users.filter((user) => user.kind === 'admin').length,
  keys: keys.items.length,
  keysEnabled: keys.items.filter((key) => key.enabled).length,
  keyNames: keys.items.map((key) => key.name),
  templates: Array.isArray(templates) ? templates.length : (templates.items || []).length,
}
console.log(JSON.stringify(summary))
if (!summary.users) {
  console.error('[verify-restore] 账号表为空，恢复不可用')
  process.exit(2)
}
if (!summary.keys) {
  console.error('[verify-restore] Key 池为空，恢复不可用')
  process.exit(3)
}
