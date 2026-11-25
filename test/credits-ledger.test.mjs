// 积分记录（r313）：账本行要能回答「扣了多少、扣在哪个动作 / 哪个节点、是充值还是退款」。
// 这一组只碰本地 SQLite 与数据目录里的 runs.json，不调任何真实上游。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-ledger-'))
process.env.DATA_DIR = dataDir
process.env.VQ_KEY_SECRET = 'test-secret-ledger'

const auth = await import('../server/auth.mjs')
const credits = await import('../server/credits.mjs')
const { config } = await import('../server/config.mjs')

const user = auth.createUser({ email: '[EMAIL:LEDGER1]', password: 'Passw0rd!demo', name: '积分用户', kind: 'user' })

// 运行记录是 flows.mjs 写进数据目录的 runs.json；这里只放一条最小记录，
// 用来验证账本 ref 里的 runId / nodeId 能对上流程名与节点标题。
fs.writeFileSync(
  path.join(config.dataDir, 'runs.json'),
  JSON.stringify([
    {
      id: 'run_ledger01',
      flowId: 'flow_ledger1',
      flowName: '商品图流水线',
      nodes: [
        { id: 'node-1', title: '主图生成' },
        { id: 'node-2', title: '场景图生成' },
      ],
    },
  ]),
)

test('工作流出图扣费能解析出 runId / nodeId / 节点名 / 流程名', () => {
  const paid = credits.charge(user.id, 'image_gen', {
    ref: 'run:run_ledger01:node-1',
    amount: 3,
    meta: { label: '工作流出图 · 白底主图', prompt: '白底主图' },
  })
  assert.equal(paid.ok, true)
  assert.equal(paid.cost, 3)

  const row = credits.ledgerOf(user.id, 1)[0]
  assert.equal(row.kind, 'image_gen')
  assert.equal(row.runId, 'run_ledger01')
  assert.equal(row.nodeId, 'node-1')
  assert.equal(row.nodeLabel, '主图生成')
  assert.equal(row.flowId, 'flow_ledger1')
  assert.equal(row.flowName, '商品图流水线')
  assert.equal(row.kindLabel, '工作流出图')
  assert.equal(row.label, '工作流出图 · 白底主图')
  // meta 不再只取 label：别的键原样保留
  assert.deepEqual(row.meta, { label: '工作流出图 · 白底主图', prompt: '白底主图' })
})

test('退款行 kindLabel 是「出图失败退款」，ref 仍能对上同一个节点', () => {
  credits.refund(user.id, 'image_gen', {
    ref: 'run:run_ledger01:node-1',
    amount: 3,
    meta: { label: '工作流出图失败退款' },
  })
  const row = credits.ledgerOf(user.id, 1)[0]
  assert.equal(row.kind, 'image_gen-refund')
  assert.equal(row.kindLabel, '出图失败退款')
  assert.equal(row.delta, 3)
  assert.equal(row.runId, 'run_ledger01')
  assert.equal(row.nodeId, 'node-1')
  assert.equal(row.nodeLabel, '主图生成')
})

test('充值行来自 credit_ledger 的 recharge，标签与余额都对', () => {
  const before = credits.balanceOf(user.id)
  credits.grant(user.id, 300, { kind: 'recharge', note: '充值 · 体验档 · ord_ledger1' })
  const row = credits.ledgerOf(user.id, 1)[0]
  assert.equal(row.kind, 'recharge')
  assert.equal(row.kindLabel, '充值')
  assert.equal(row.delta, 300)
  assert.equal(row.balance, before + 300)
  assert.match(row.ref, /充值/)
  assert.match(row.ref, /ord_ledger1/)
})

test('赠送与管理员扣减各有中文标签', () => {
  credits.grant(user.id, 8, { kind: 'welcome', note: '新手赠送' })
  const gift = credits.ledgerOf(user.id, 1)[0]
  assert.equal(gift.kind, 'welcome')
  assert.equal(gift.kindLabel, '新手赠送')
  assert.equal(gift.delta, 8)

  credits.grant(user.id, -2, { note: '后台扣减' })
  const deduct = credits.ledgerOf(user.id, 1)[0]
  assert.equal(deduct.kind, 'deduct')
  assert.equal(deduct.kindLabel, '管理员扣减')
  assert.equal(deduct.delta, -2)
})

test('分页：offset 边界不重不漏，越过末页返回空', () => {
  const pager = auth.createUser({ email: '[EMAIL:LEDGER2]', password: 'Passw0rd!demo', name: '翻页用户', kind: 'user' })
  for (let i = 0; i < 5; i += 1) credits.grant(pager.id, i + 1, { note: '第 ' + (i + 1) + ' 笔' })

  // 新账号自带一笔 welcome 初始额度：5 笔发放 + 1 笔赠送 = 6 行
  assert.equal(credits.ledgerCountOf(pager.id), 6)
  const first = credits.ledgerOf(pager.id, 2, 0)
  const second = credits.ledgerOf(pager.id, 2, 2)
  const third = credits.ledgerOf(pager.id, 2, 4)
  assert.equal(first.length, 2)
  assert.equal(second.length, 2)
  assert.equal(third.length, 2)
  const ids = [...first, ...second, ...third].map((row) => row.id)
  assert.equal(new Set(ids).size, 6)
  assert.deepEqual(credits.ledgerOf(pager.id, 2, 6), [])
  assert.deepEqual(credits.ledgerOf(pager.id, 2, 99), [])
})

test('老字段一个不少，解析不到运行时不编造节点', () => {
  const plain = auth.createUser({ email: '[EMAIL:LEDGER3]', password: 'Passw0rd!demo', name: '检索用户', kind: 'user' })
  credits.grant(plain.id, 50, { note: '测试发放' })
  credits.charge(plain.id, 'search', { ref: '检索 · 毛衣', amount: 2, meta: { label: '毛衣检索' } })

  const row = credits.ledgerOf(plain.id, 10).find((item) => item.kind === 'search')
  assert.ok(row)
  for (const key of ['id', 'delta', 'balance', 'kind', 'ref', 'label', 'createdAt', 'meta', 'runId', 'nodeId', 'nodeLabel', 'flowId', 'flowName', 'kindLabel']) {
    assert.ok(key in row, '缺少字段 ' + key)
  }
  assert.equal(row.delta, -2)
  assert.equal(row.label, '毛衣检索')
  assert.equal(row.kindLabel, '检索')
  // 普通检索没有运行痕迹：节点与流程留空，而不是拿 ref 猜一个
  assert.equal(row.runId, '')
  assert.equal(row.nodeId, '')
  assert.equal(row.nodeLabel, '')
  assert.equal(row.flowId, '')
  assert.equal(row.flowName, '')
})
