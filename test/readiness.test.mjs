// 上线就绪（v0.9.67）。这一组盯住三件事：
//   1) 判定是纯函数：给一份状态就能算出六道门各自是就绪 / 一半 / 未配，不依赖真实配置；
//   2) 真实取数能接上：空数据目录全绿不起来，把邮件、告警、档位、额度、公示逐项配好后才会变成「六项都就绪」；
//   3) 不报假绿：读不到的状态按「未配置」算，缺一项 verdict 就还是 not-ready。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-ready-'))
process.env.VQ_KEY_SECRET = 'test-secret-ready'
delete process.env.VQ_ICP
delete process.env.VQ_SUPPORT_EMAIL
delete process.env.VQ_SMTP_HOST
delete process.env.VQ_ALERT_WEBHOOK
delete process.env.VQ_BACKUP_OFFSITE

const readiness = await import('../server/readiness.mjs')
const siteInfo = await import('../server/site-info.mjs')
const mailConfig = await import('../server/mail-config.mjs')
const alertChannel = await import('../server/alert-channel.mjs')
const plans = await import('../server/plans.mjs')
const quota = await import('../server/quota.mjs')

test('纯判定：什么都没配时只有「额度」算一半，其余五道门都是未配', () => {
  const view = readiness.readinessGates({})
  assert.equal(view.gates.length, 6)
  const stateOf = Object.fromEntries(view.gates.map((gate) => [gate.key, gate.state]))
  assert.deepEqual(stateOf, { pricing: 'todo', site: 'todo', mail: 'todo', alerts: 'todo', backup: 'todo', quota: 'partial' })
  assert.equal(view.totals.ready, 0)
  assert.equal(view.totals.todo, 5)
  assert.equal(view.verdict, 'not-ready')
  assert.match(view.verdictText, /5 项没配/)
  // 每道门都给出「去哪里填」，后台点一下就到
  for (const gate of view.gates) assert.match(gate.action.section, /^(billing|system)$/)
})

test('不报假绿：缺失项会写进 summary，一半的情况不会被说成就绪', () => {
  const view = readiness.readinessGates({
    site: { icp: '', operator: '某某公司', supportEmail: '', missing: ['ICP 备案号', '客服邮箱'], complete: false },
    quota: { monthlyLimit: 0 },
  })
  const site = view.gates.find((gate) => gate.key === 'site')
  assert.equal(site.state, 'partial')
  assert.match(site.summary, /还缺：ICP 备案号、客服邮箱/)
  assert.equal(view.verdict, 'not-ready')
})

test('读不到的配置按未配置算，不会因为异常变成就绪', async () => {
  const view = await readiness.launchReadiness()
  assert.equal(view.ok, true)
  assert.equal(view.verdict, 'not-ready')
  assert.equal(view.gates.every((gate) => gate.state !== 'ready'), true)
})

test('逐项配齐之后才变成「六项都就绪」', async () => {
  // 公示：备案号 + 主体 + 客服邮箱
  await siteInfo.saveSiteInfo({
    icp: '沪ICP备2026000000号-1',
    operator: '上海某某文化传媒有限公司',
    supportEmail: 'support@example.com',
  })
  // 邮件通道
  const mail = await mailConfig.saveMail(
    { host: 'smtp.example.test', port: 465, secure: true, user: 'robot@example.test', pass: 'smtp-secret-123', fromAddress: 'robot@example.test', fromName: 'VisionQA' },
    { by: 'admin@vision.test' },
  )
  assert.equal(mail.ok, true)
  // 告警外推
  const channel = await alertChannel.saveChannel({ url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdef123456', by: 'admin@vision.test' })
  assert.equal(channel.ok, true)
  // 定价档位
  const plan = plans.savePlan({ name: '标准版', credits: 1000, priceCents: 29900 }, 'admin@vision.test')
  assert.equal(plan.ok, true)
  // 每月额度
  const saved = quota.saveQuota({ monthlyLimit: 500 }, 'admin@vision.test')
  assert.equal(saved.ok, true)
  // 异地备份：备份进程写状态文件，这里用环境变量表达「目的地已配」
  process.env.VQ_BACKUP_OFFSITE = '/mnt/offsite/visionqa'

  const view = await readiness.launchReadiness()
  const stateOf = Object.fromEntries(view.gates.map((gate) => [gate.key, gate.state]))
  assert.equal(stateOf.mail, 'ready')
  assert.equal(stateOf.alerts, 'ready')
  assert.equal(stateOf.backup, 'ready')
  assert.equal(stateOf.quota, 'ready')
  assert.equal(stateOf.site, 'ready')
  // 定价：档位有了，但支付通道仍未接 —— 只算一半，不能算就绪
  assert.equal(stateOf.pricing, 'partial')
  assert.equal(view.totals.partial, 1)
  assert.equal(view.verdict, 'not-ready')
  assert.match(view.verdictText, /1 项只做了一半/)
  const pricing = view.gates.find((gate) => gate.key === 'pricing')
  assert.match(pricing.summary, /501/)
})
