// r293：用户写死的参数要能原样提交（不再被默认档位顶掉），默认档位仍然照旧校验。
// 纯函数，不起服务、不打上游。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-media-locked-'))
process.env.DATA_DIR = dir

const { resolveSelection, sizeFromRatio, normalizeSize } = await import('../server/media-models.mjs')

test('视频：locked 的秒数与清晰度原样保留，并回给界面 locked 标记', () => {
  const twelve = resolveSelection({ kind: 'video', duration: 12, locked: { duration: true } })
  assert.equal(twelve.duration, 12)
  assert.equal(twelve.locked.duration, true)

  const hd = resolveSelection({ kind: 'video', resolution: '1080p', locked: { resolution: true } })
  assert.equal(hd.resolution, '1080p')
  assert.equal(hd.locked.resolution, true)

  const wide = resolveSelection({ kind: 'video', ratio: '21:9', locked: { ratio: true } })
  assert.equal(wide.ratio, '21:9')
  assert.equal(wide.locked.ratio, true)
})

test('视频：没标 locked 的越界值仍然拒绝（界面下拉不可能传这种值，走到这里就是拼错了）', () => {
  assert.throws(() => resolveSelection({ kind: 'video', duration: 12 }), /时长只能是/)
  assert.throws(() => resolveSelection({ kind: 'video', resolution: '1080p' }), /分辨率只能是/)
  assert.throws(() => resolveSelection({ kind: 'video', ratio: '21:9' }), /比例只能是/)
  // 秒数本身不合理的，即使写了 locked 也不收
  assert.throws(() => resolveSelection({ kind: 'video', duration: 120, locked: { duration: true } }), /1–60/)
  assert.throws(() => resolveSelection({ kind: 'video', duration: 0, locked: { duration: true } }), /1–60/)
})

test('图片：写死的尺寸直接当 size；写死的冷门比例按比例算一个尺寸', () => {
  const big = resolveSelection({ kind: 'image', size: '2048x2048', locked: { size: true } })
  assert.equal(big.size, '2048x2048')
  assert.equal(big.locked.size, true)

  const fourFive = resolveSelection({ kind: 'image', ratio: '4:5', locked: { ratio: true } })
  assert.equal(fourFive.ratio, '4:5')
  assert.equal(fourFive.size, '1232x1536')
  assert.equal(fourFive.locked.ratio, true)

  // 表里那三档还是走原来的尺寸，不受影响
  const story = resolveSelection({ kind: 'image', ratio: '9:16' })
  assert.equal(story.size, '1024x1536')
  assert.deepEqual(story.locked, {})
})

test('尺寸换算与归一：4:5 / 9:16 / 坏输入', () => {
  assert.equal(sizeFromRatio('4:5'), '1232x1536')
  assert.equal(sizeFromRatio('9:16'), '864x1536')
  assert.equal(sizeFromRatio('乱写'), '')
  assert.equal(normalizeSize('2048×2048'), '2048x2048')
  assert.equal(normalizeSize('2048 * 2048'), '2048x2048')
  assert.equal(normalizeSize('2048'), '')
  assert.equal(normalizeSize('99999x1'), '')
})
