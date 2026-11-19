import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

// 智能体文件坏了（r268）：这一份不能像别的那九份一样「读不出来就抛」——
// 对话预设是每个创作页的入口，整站跟着不可用代价太大。改成「先备份、再降级」：
//   1. 原件挪到 agents.json.broken-<时间戳>，一个字节都不丢；
//   2. 界面拿到的是默认预设 + 一条说明（现在是默认预设、备份叫什么、还能不能写）；
//   3. 备份得走 → 用户下一次新建/修改生成新文件，正常用；
//   4. 备份走不掉 → 一个字节都不许写，否则新文件盖掉唯一一份原件。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-agents-corrupt-'))
process.env.DATA_DIR = dir
const file = path.join(dir, 'agents.json')
const BROKEN = '{ "broken": '

const writeBroken = () => fs.writeFileSync(file, BROKEN, 'utf8')
const readBrokenBack = (name) => fs.readFileSync(path.join(dir, name), 'utf8')

// 每次取一个新的模块实例：agents 存储有内存缓存，同一份坏了只会在第一次读时处理。
let seq = 0
const freshStore = () => import('../server/agents.mjs?case=' + ++seq)

function assertDegraded(notice, { canWrite, backup }) {
  assert.ok(notice, '坏了以后必须有一条说明')
  assert.equal(notice.degraded, true)
  assert.equal(notice.canWrite, canWrite)
  assert.match(notice.message, /读不出来/)
  if (backup) assert.match(notice.backup, /^agents\.json\.broken-\d+$/)
  else assert.equal(notice.backup, '')
}

test('文件坏了：先备份原件，再给默认预设，并说清楚现在是默认预设', async () => {
  writeBroken()
  const store = await freshStore()
  // 一上来没有说明：坏文件是在第一次读的时候才被发现
  assert.equal(store.agentStoreNotice(), null)

  const list = await store.listAgents({}, null)
  assert.equal(list.length, 4, '入口不能空：给默认预设，页面还能用')
  assert.ok(list.every((item) => item.name && item.systemPrompt.length > 10))

  const notice = store.agentStoreNotice()
  assertDegraded(notice, { canWrite: true, backup: true })
  // 原件还在，只是换了名字；agents.json 这个位置暂时空着（下一次写才生成新文件）
  assert.equal(readBrokenBack(notice.backup), BROKEN)
  assert.equal(fs.existsSync(file), false)
})

test('备份得走：下一次新建生成新文件，默认预设与新条目都在', async () => {
  writeBroken()
  const store = await freshStore()
  const created = await store.createAgent(
    {
      name: '坏了之后新建的',
      category: '内容复刻',
      role: '验证新建能落盘',
      systemPrompt: '你是测试用的对话预设，只按用户给的素材输出，缺的信息写「待确认」。',
      temperature: 0.3,
      knowledge: [],
      tools: [],
    },
    null,
  )
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.ok(Array.isArray(onDisk))
  assert.equal(onDisk.length, 5, '4 份默认预设 + 这次新建的 1 份')
  assert.ok(onDisk.some((item) => item.id === created.id))
  // 说明不会因为写过一次就消失：这一进程里用户仍然知道自己面对的是降级数据
  assertDegraded(store.agentStoreNotice(), { canWrite: true, backup: true })
})

test('写进去的不是一条：原文件备份后内容没被改过', async () => {
  writeBroken()
  const store = await freshStore()
  await store.listAgents({}, null)
  const { backup } = store.agentStoreNotice()
  const before = readBrokenBack(backup)
  await store.createAgent(
    {
      name: '再写一条',
      category: '视觉评审',
      role: '确认备份不被覆盖',
      systemPrompt: '你是测试用的对话预设，评审结论只用 通过 / 待确认 / 问题 三档。',
      temperature: 0.2,
      knowledge: [],
      tools: [],
    },
    null,
  )
  assert.equal(readBrokenBack(backup), before)
  assert.equal(readBrokenBack(backup), BROKEN)
})

test('备份走不掉：一个字节都不写，读取仍然给默认预设', async () => {
  writeBroken()
  const original = fsp.rename
  fsp.rename = async () => {
    const error = new Error('拒绝访问')
    error.code = 'EPERM'
    throw error
  }
  try {
    const store = await freshStore()
    const list = await store.listAgents({}, null)
    assert.equal(list.length, 4, '读仍然要能给出默认预设，页面不能白屏')
    const notice = store.agentStoreNotice()
    assertDegraded(notice, { canWrite: false, backup: false })
    assert.match(notice.message, /不能新建或修改/)

    await assert.rejects(
      () =>
        store.createAgent(
          {
            name: '这份写不进去',
            category: '投放素材',
            role: '验证写被拦住',
            systemPrompt: '你是测试用的对话预设，不要编造价格、授权或效果数据。',
            temperature: 0.5,
            knowledge: [],
            tools: [],
          },
          null,
        ),
      (error) => {
        assert.equal(error.code, 'STORE_UNREADABLE')
        assert.match(error.message, /没有改动任何内容/)
        return true
      },
    )
    // 原件一个字都没动：既没被改名，也没被新文件盖掉
    assert.equal(fs.readFileSync(file, 'utf8'), BROKEN)
  } finally {
    fsp.rename = original
  }
})

test('顶层不是数组也算坏文件（以前会被当成空库）', async () => {
  fs.writeFileSync(file, JSON.stringify({ items: [] }), 'utf8')
  const store = await freshStore()
  const list = await store.listAgents({}, null)
  assert.equal(list.length, 4)
  const notice = store.agentStoreNotice()
  assertDegraded(notice, { canWrite: true, backup: true })
  assert.equal(readBrokenBack(notice.backup), JSON.stringify({ items: [] }))
})
