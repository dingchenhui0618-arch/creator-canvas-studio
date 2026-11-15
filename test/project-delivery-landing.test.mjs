// 交付深链（v0.9.140）：工作台点一行，落在作品页的那一版档案上。
// 这组钉住三件事：
//   1) 地址只认「作品 + 交付记录 id」这个形状，缺一段就退回作品页，坏链接不白屏；
//   2) 按交付记录 id 找，不按版次猜——同一版重新封过包会换一条记录；
//   3) 那一句「你是从哪来的」四种情况都有话说：有回执 / 没回执 / 没包 / 找不到。
import test from 'node:test'
import assert from 'node:assert/strict'

const { deliveryLandingOf, deliveryLandingText } = await import('../src/domain/project.ts')
const { deliveryLinkFromSegments, deliveryLinkHash } = await import('../src/domain/delivery-link.ts')

const sha = 'a'.repeat(64)
const pkg = { bytes: 1024, sha256: sha, fileName: '交付包.zip', savedAt: '2026-11-15T10:00:00.000Z', fileCount: 2, files: [] }
const project = {
  deliveries: [
    { version: 1, at: '2026-11-15T09:00:00.000Z', id: 'dlv-one', package: pkg },
    {
      version: 2,
      at: '2026-11-15T10:00:00.000Z',
      id: 'dlv-two',
      package: pkg,
      receipt: { at: '2026-11-15T10:05:00.000Z', state: 'mismatch', via: 'you', summary: '哈希对不上：收据上是 cccc…，这一条是 aaaa…。' },
    },
    { version: 3, at: '2026-11-15T11:00:00.000Z' },
  ],
}

test('深链只认 projects/<作品>/delivery/<交付记录>：缺一段都退回作品页', () => {
  assert.deepEqual(deliveryLinkFromSegments(['projects', 'prj_1', 'delivery', 'dlv_1']), { projectId: 'prj_1', deliveryId: 'dlv_1' })
  assert.equal(deliveryLinkFromSegments(['projects', 'prj_1']), null)
  assert.equal(deliveryLinkFromSegments(['projects', 'prj_1', 'delivery']), null)
  assert.equal(deliveryLinkFromSegments(['projects', 'prj_1', 'delivery', '']), null)
  assert.equal(deliveryLinkFromSegments(['projects', '', 'delivery', 'dlv_1']), null)
  assert.equal(deliveryLinkFromSegments(['review', 'prj_1', 'delivery', 'dlv_1']), null)
  assert.equal(deliveryLinkFromSegments([]), null)
})

test('地址两段 id 都编码：中文、空格、斜杠都不会把路径切错', () => {
  const hash = deliveryLinkHash('作品 1', 'dlv/1')
  assert.equal(hash, '#/projects/' + encodeURIComponent('作品 1') + '/delivery/' + encodeURIComponent('dlv/1'))
  const segments = hash.replace(/^#\//, '').split('/').map((piece) => decodeURIComponent(piece))
  assert.deepEqual(deliveryLinkFromSegments(segments), { projectId: '作品 1', deliveryId: 'dlv/1' })
})

test('按交付记录 id 落在那一版上：封过包的连回执结论一起带出来', () => {
  assert.deepEqual(deliveryLandingOf(project, 'dlv-two'), {
    id: 'dlv-two',
    version: 2,
    hasPackage: true,
    receipt: { state: 'mismatch' },
    missing: false,
  })
  const older = deliveryLandingOf(project, 'dlv-one')
  assert.equal(older?.version, 1)
  assert.equal(older?.receipt, null, '没贴过回执就是 null，不写成 unknow')
})

test('没封包的那一版、找不到的编号、空编号各有各的说法', () => {
  // 只有版次、没有记录编号的那一版认不出来：深链按编号找，不按版次猜
  assert.equal(deliveryLandingOf(project, 'dlv-three').missing, true)
  const noPackage = deliveryLandingOf({ deliveries: [{ version: 3, at: '', id: 'dlv-plain' }] }, 'dlv-plain')
  assert.deepEqual(noPackage, { id: 'dlv-plain', version: 3, hasPackage: false, receipt: null, missing: false })
  const missing = deliveryLandingOf(project, 'dlv-gone')
  assert.deepEqual(missing, { id: 'dlv-gone', version: 0, hasPackage: false, receipt: null, missing: true })
  assert.equal(deliveryLandingOf(project, ''), null)
  assert.equal(deliveryLandingOf(null, 'dlv-two').missing, true, '空作品不炸：直接说找不到')
})

test('那一句话四种情况都能说出口', () => {
  assert.equal(deliveryLandingText(null), '')
  assert.equal(
    deliveryLandingText(deliveryLandingOf(project, 'dlv-two')),
    '从工作台点进来的这一条：v2 · 回执对不上，收据已经摊开。',
  )
  assert.equal(
    deliveryLandingText(deliveryLandingOf(project, 'dlv-one')),
    '从工作台点进来的这一条：v1 · 还没收到回执，下面可以贴一段收据对一遍。',
  )
  assert.equal(
    deliveryLandingText(deliveryLandingOf({ deliveries: [{ version: 3, at: '', id: 'dlv-plain' }] }, 'dlv-plain')),
    '从工作台点进来的这一条：v3 · 这一版没封存包，只有交付记录。',
  )
  assert.equal(
    deliveryLandingText(deliveryLandingOf(project, 'dlv-gone')),
    '从工作台点进来的那一条已经不在这份档案里了：可能这一版后来重新封过包。',
  )
})
