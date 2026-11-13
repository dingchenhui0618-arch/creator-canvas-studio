// 评审缩图（v0.9.74）：堆占用跟着送审字节数走，所以图要在发模型之前变小。
// 这一组盯四件事：判定纯函数的边界（不放大 / 小图不动 / 像素过多跳过）、
// 真缩一张图（尺寸与字节都下去）、缓存命中不重复跑 ffmpeg、缩不动就原样返回（不拖垮评审）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import { compressForReview, fitInside, planReviewImage, sweepReviewCache } from '../server/image-scale.mjs'

const run = promisify(execFile)
const MB = 1024 * 1024

test('fitInside：只缩不放大，长边封顶，比例保持', () => {
  assert.deepEqual(fitInside(3000, 2000, 1600), { width: 1600, height: 1067 })
  assert.deepEqual(fitInside(2000, 3000, 1600), { width: 1067, height: 1600 })
  assert.deepEqual(fitInside(1200, 800, 1600), { width: 1200, height: 800 })
  assert.deepEqual(fitInside(800, 800, 1600), { width: 800, height: 800 })
  assert.deepEqual(fitInside(0, 800, 1600), null)
  // 长边写 0 = 关掉缩图（只重压）
  assert.deepEqual(fitInside(3000, 2000, 0), { width: 3000, height: 2000 })
})

test('planReviewImage：超过长边就缩，框内但字节大就重压，像素过多不碰', () => {
  // 3000x2000 / 8 MB：缩到 1600x1067
  const big = planReviewImage({ bytes: 8 * MB, width: 3000, height: 2000 })
  assert.equal(big.scale, true)
  assert.equal(big.reason, 'DOWNSCALE')
  assert.deepEqual(big.target, { width: 1600, height: 1067 })
  // 1200x1200 / 8 MB：尺寸不用缩，但字节要把 base64 撑到 10 MB，重压
  const heavy = planReviewImage({ bytes: 8 * MB, width: 1200, height: 1200 })
  assert.equal(heavy.scale, true)
  assert.equal(heavy.reason, 'RECOMPRESS')
  // 800x600 / 200 KB：本来就不占堆，别白跑一次 ffmpeg
  const small = planReviewImage({ bytes: 200 * 1024, width: 800, height: 600 })
  assert.equal(small.scale, false)
  assert.equal(small.reason, 'SMALL_ENOUGH')
  // 8 MB 的 JPEG 可以是 1 亿像素：交给 ffmpeg 解等于换一种方式打内存
  const bomb = planReviewImage({ bytes: 8 * MB, width: 12000, height: 9000 })
  assert.equal(bomb.scale, false)
  assert.equal(bomb.reason, 'TOO_MANY_PIXELS')
  // 空字节 / 读不到尺寸（宽高为 0）都不崩
  assert.equal(planReviewImage({ bytes: 0 }).reason, 'EMPTY')
  assert.equal(planReviewImage({ bytes: 3 * MB, width: 0, height: 0 }).reason, 'RECOMPRESS')
})

test('compressForReview：真缩一张 2400x1400 的图，尺寸与字节都下去，第二次走缓存', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vq-scale-test-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const work = path.join(dir, 'work')
  await fsp.mkdir(work, { recursive: true })
  const source = path.join(dir, 'source.jpg')
  try {
    // testsrc2 是合成画面，生成只需几十毫秒；再补到 3 MB 让「字节大」这一条也成立
    await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=2400x1400:rate=1', '-frames:v', '1', '-q:v', '2', source], { maxBuffer: 4 * MB })
  } catch (error) {
    t.skip('本机没有可用的 ffmpeg：' + String(error?.message || error).slice(0, 80))
    return
  }
  const core = await fsp.readFile(source)
  const original = Buffer.concat([core, Buffer.alloc(Math.max(0, 3 * MB - core.length))])
  assert.ok(original.length >= 3 * MB)

  const first = await compressForReview(original, 'image/jpeg', { dir: work, minBytes: 1024 * 1024, maxEdge: 1600 })
  assert.equal(first.report.applied, true)
  assert.equal(first.report.reason, 'DOWNSCALE')
  assert.equal(first.mime, 'image/jpeg')
  assert.ok(first.bytes.length < original.length)
  assert.ok(first.bytes.length < 512 * 1024, '缩完应该在几百 KB 以内，实际 ' + first.bytes.length)
  assert.equal(first.report.originalBytes, original.length)
  assert.equal(first.report.sentBytes, first.bytes.length)
  assert.equal(first.report.width, 1600)
  assert.equal(first.report.height, 933)

  // 输出是一张真能解的图，不是被截断的字节
  const outFile = path.join(dir, 'out.jpg')
  await fsp.writeFile(outFile, first.bytes)
  const probe = await run(ffprobeStatic.path, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', outFile], { maxBuffer: MB })
  assert.deepEqual(JSON.parse(probe.stdout).streams[0], { width: 1600, height: 933 })

  // 同一张图再来一次：命中缓存，不再读源图、不再跑 ffmpeg
  const second = await compressForReview(original, 'image/jpeg', { dir: work, minBytes: 1024 * 1024, maxEdge: 1600 })
  assert.equal(second.report.applied, true)
  assert.equal(second.report.cached, true)
  assert.equal(second.bytes.length, first.bytes.length)
})

test('compressForReview：缩不动就原样返回，评审不因缩图失败而失败', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vq-scale-fail-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  // 不是图片：ffprobe 读不出尺寸，ffmpeg 也解不了
  const junk = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2 * MB, 0x41)])
  const result = await compressForReview(junk, 'image/jpeg', { dir, minBytes: 1024 * 1024 })
  assert.equal(result.report.applied, false)
  assert.ok(result.bytes.equals(junk), '失败时必须原样返回，不能给评审一个半截文件')
  assert.ok(['SCALE_FAILED', 'PROBE_FAILED'].includes(result.report.reason), result.report.reason)

  // 类型不认识（比如给了一张 gif）就不碰
  const gif = await compressForReview(Buffer.alloc(2 * MB), 'image/gif', { dir })
  assert.equal(gif.report.applied, false)
  assert.equal(gif.report.reason, 'NOT_IMAGE')
  // 长边写 0 = 关掉
  const off = await compressForReview(Buffer.alloc(2 * MB, 1), 'image/jpeg', { dir, maxEdge: 0 })
  assert.equal(off.report.reason, 'DISABLED')
})

test('sweepReviewCache：过期文件删掉，数量超了删最旧的', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vq-scale-sweep-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const now = Date.now()
  const old = path.join(dir, 'old.jpg')
  await fsp.writeFile(old, 'x')
  await fsp.utimes(old, new Date(now - 30 * 24 * 60 * 60 * 1000), new Date(now - 30 * 24 * 60 * 60 * 1000))
  for (let i = 0; i < 4; i += 1) {
    const file = path.join(dir, 'new-' + i + '.jpg')
    await fsp.writeFile(file, 'x')
    await fsp.utimes(file, new Date(now - i * 1000), new Date(now - i * 1000))
  }
  const first = await sweepReviewCache(dir, { maxCacheFiles: 2, cacheMaxAgeMs: 7 * 24 * 60 * 60 * 1000, now })
  assert.equal(first.removed, 3, '1 个过期 + 2 个超量')
  const left = (await fsp.readdir(dir)).sort()
  assert.deepEqual(left, ['new-0.jpg', 'new-1.jpg'])
})
