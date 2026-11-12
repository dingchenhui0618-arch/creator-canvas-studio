import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 服务端模块的「加载即校验」：ESM 的具名导入在链接期就要求导出存在，
// 少一个名字（例如把 listTrash 写成 listTemplateTrash）会让整个进程起不来。
// 这个测试挨个 import 一遍，等价于一次「能不能启动」的检查，但不用真的监听端口。
//
// 不 import index.mjs：它会 listen 8799 并起告警轮询。其余模块都允许有副作用（读写 data 目录）。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-modules-'))
process.env.DATA_DIR = dir

const EXPECTED = {
  'account.mjs': ['exportAccount', 'deleteOwnAccount', 'exportFileName'],
  'projects.mjs': ['listProjects', 'getProject', 'createProject', 'updateProject', 'deleteProject', 'deleteProjectsByOwner'],
  'routes/projects.mjs': ['createProjectsRouter'],
  'templates.mjs': ['listTemplates', 'listTrash', 'restoreTemplate', 'purgeTemplate', 'deleteTemplatesByOwner', 'enableTemplateShare', 'disableTemplateShare', 'getSharedTemplate', 'publicTemplateView'],
  'routes/account.mjs': ['createAccountRouter'],
  'routes/auth.mjs': ['createAuthRouter'],
  'totp.mjs': ['totp', 'verifyTotp', 'generateSecret', 'generateBackupCodes', 'matchBackupCode'],
  'client-errors.mjs': ['recordClientError', 'listClientErrors', 'clearClientErrors'],
  'log-files.mjs': ['appendLog', 'pruneLogs', 'listLogs', 'startLogRetention'],
  'search-history.mjs': ['recordSearch', 'listSearchHistory', 'toggleSearchFavorite', 'clearSearchHistory'],
}

const ROOTS = ['templates.mjs', 'account.mjs', 'projects.mjs', 'routes/projects.mjs', 'routes/account.mjs', 'totp.mjs', 'client-errors.mjs', 'log-files.mjs', 'search-history.mjs', 'owner.mjs', 'speech.mjs']

test('服务端模块都能加载，关键导出都存在', async () => {
  for (const name of ROOTS) {
    const module = await import('../server/' + name)
    for (const key of EXPECTED[name] || []) {
      assert.equal(typeof module[key], 'function', name + ' 缺少导出 ' + key)
    }
  }
})
