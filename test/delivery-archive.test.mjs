import test from 'node:test'
import assert from 'node:assert/strict'

// 交付档案（v0.9.126）：作品页要能回答「这条作品交过几版、哪几版还取得到包」。
// 这组只测客户端派生规则：
//   1) deliveryOf 必须把 id / package 一起带出来，否则「包已封存」的提示永远不出现；
//   2) 档案按交付时间倒序，没包的老记录也要留下，不能凭空消失；
//   3) 合计字节只算能下载的那几个包；
//   4) 大小与 SHA 的显示口径固定，不靠界面各自拼。

const domain = await import('../src/domain/project.ts')
const { deliveryArchive, deliveryOf, packageBytesLabel, packageShortSha } = domain

const sha = 'a'.repeat(64)
const pkg = (bytes, extra = {}) => ({ bytes, sha256: sha, fileName: '交付包-' + bytes + '.zip', savedAt: '2026-11-15T10:00:00.000Z', ...extra })
const delivery = (version, at, extra = {}) => ({ version, at, ...extra })

test('deliveryOf 带出 id 与 package：标记交付后的提示靠它说「包已封存」', () => {
  const project = {
    deliveries: [
      delivery(1, '2026-11-15T09:00:00.000Z', { id: '1111111111111111', package: pkg(111) }),
      delivery(2, '2026-11-15T10:00:00.000Z', { id: '2222222222222222', package: pkg(222) }),
    ],
  }
  const last = deliveryOf(project)
  assert.equal(last?.version, 2)
  assert.equal(last?.id, '2222222222222222')
  assert.equal(last?.package?.bytes, 222)
  assert.equal(deliveryOf({ deliveries: [delivery(1, '')] })?.package, undefined)
  assert.equal(deliveryOf({ deliveries: [] }), null)
})

test('交付档案：最近的排前面，没包的老记录也留着，字节只算有包的', () => {
  const project = {
    deliveries: [
      delivery(1, '2026-11-15T09:00:00.000Z', { id: '1111111111111111', package: pkg(1000) }),
      delivery(2, '2026-11-15T10:00:00.000Z'),
      delivery(3, '2026-11-15T11:00:00.000Z', { id: '3333333333333333', package: pkg(2048) }),
    ],
  }
  const archive = deliveryArchive(project)
  assert.deepEqual(archive.rows.map((row) => row.version), [3, 2, 1])
  assert.equal(archive.sealed, 2)
  assert.equal(archive.legacy, 1)
  assert.equal(archive.bytes, 3048)
})

test('交付档案：只有 id 没有包、只有包没有 id 都不算能下载', () => {
  const project = {
    deliveries: [
      delivery(1, '', { id: '1111111111111111' }),
      delivery(2, '', { package: pkg(500) }),
    ],
  }
  const archive = deliveryArchive(project)
  assert.equal(archive.sealed, 0)
  assert.equal(archive.legacy, 2)
  assert.equal(archive.bytes, 0)
})

test('交付档案：空作品 / 坏记录不炸，版次为 0 的残行不列', () => {
  assert.deepEqual(deliveryArchive(null), { rows: [], sealed: 0, legacy: 0, bytes: 0 })
  assert.deepEqual(deliveryArchive({}), { rows: [], sealed: 0, legacy: 0, bytes: 0 })
  const archive = deliveryArchive({ deliveries: [null, { version: 0 }, delivery(2, '', { id: '2222222222222222', package: pkg(10) })] })
  assert.deepEqual(archive.rows.map((row) => row.version), [2])
  assert.equal(archive.sealed, 1)
})

test('包大小口径：B / KB / MB 三档，负数与坏值都按 0', () => {
  assert.equal(packageBytesLabel(0), '0 B')
  assert.equal(packageBytesLabel(1023), '1023 B')
  assert.equal(packageBytesLabel(1024), '1 KB')
  assert.equal(packageBytesLabel(250142), '244 KB')
  assert.equal(packageBytesLabel(2621440), '2.5 MB')
  assert.equal(packageBytesLabel(-5), '0 B')
  assert.equal(packageBytesLabel(Number.NaN), '0 B')
})

test('SHA 只露前 12 位：大写先归一，坏值不硬截', () => {
  assert.equal(packageShortSha(sha), 'aaaaaaaaaaaa…')
  assert.equal(packageShortSha(sha.toUpperCase()), 'aaaaaaaaaaaa…')
  assert.equal(packageShortSha('not-a-sha'), '')
  assert.equal(packageShortSha(''), '')
})
