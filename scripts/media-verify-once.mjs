#!/usr/bin/env node
// 真调一次智能体页的生图 / 生视频，验证「界面选的比例 → 平台网关 → 上游 → 落盘下载」整条链路。
//
// 为什么要有它：单测里的假上游只证明我们发出的 body 对不对，证明不了上游真的接受、真的出片、
// 真的能下载回来。这一版就吃过亏——生视频漏传 aspect_ratio，单测全绿，真调 4 秒被拒。
//
// 用法（在生产机上跑，服务用户执行）：
//   sudo -u visionqa env DATA_DIR=/var/lib/visionqa node --experimental-sqlite \
//     scripts/media-verify-once.mjs --user usr_xxx --kind video --ratio 16:9 --duration 8 \
//     --resolution 720p --out /tmp/v16x9.mp4
//
// 约定：
//   - 只按 user id 找账号（不传手机号 / 邮箱，输出里也不会出现）；
//   - 用该账号签一个临时会话，跑完立刻撤销，不在浏览器里留东西；
//   - 会真实扣积分、真实花钱，所以必须显式给 --kind，不提供「顺手跑一遍」的默认值。
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createSession, destroySession, findUserById } from '../server/auth.mjs'

const POLL_INTERVAL_MS = 5000
const TIMEOUT_MS = { image: 180 * 1000, video: 12 * 60 * 1000 }

const USAGE = `用法：node --experimental-sqlite scripts/media-verify-once.mjs --user <id> --kind image|video
       [--ratio 1:1|9:16|16:9] [--duration 4|8] [--resolution 480p|720p]
       [--prompt "..."] [--base http://127.0.0.1:8799] [--out /tmp/x.mp4]`

function parseArgs(argv) {
  const out = { base: 'http://127.0.0.1:8799', kind: '', user: '', ratio: '', duration: 0, resolution: '', prompt: '', out: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) throw new Error('看不懂这个参数：' + key)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error('参数 ' + key + ' 后面缺值')
    i += 1
    const name = key.slice(2)
    if (!(name in out)) throw new Error('不认识的参数：' + key)
    out[name] = name === 'duration' ? Number(value) : value
  }
  if (!out.user) throw new Error('必须给 --user（账号 id，不是手机号）')
  if (out.kind !== 'image' && out.kind !== 'video') throw new Error('--kind 只能是 image 或 video')
  if (out.kind === 'image') {
    out.ratio = out.ratio || '1:1'
    out.prompt = out.prompt || '一只橘猫坐在窗台上晒太阳，暖色午后光线'
    out.out = out.out || '/tmp/media-verify-image.png'
  } else {
    out.ratio = out.ratio || '9:16'
    out.duration = out.duration || 4
    out.resolution = out.resolution || '720p'
    out.prompt = out.prompt || '一只橘猫在窗台上伸懒腰，午后暖光，镜头缓慢推进'
    out.out = out.out || '/tmp/media-verify-video.mp4'
  }
  out.base = out.base.replace(/\/+$/, '')
  return out
}

function body(opts) {
  if (opts.kind === 'image') return { kind: 'image', prompt: opts.prompt, ratio: opts.ratio }
  return { kind: 'video', prompt: opts.prompt, ratio: opts.ratio, duration: opts.duration, resolution: opts.resolution }
}

async function call(url, cookie, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, ...(init.headers || {}) },
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, json, text }
}

function probeFfprobe(file) {
  const result = spawnSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ], { encoding: 'utf8' })
  if (result.status !== 0 || !result.stdout) return null
  const [width, height] = result.stdout.trim().split(/\r?\n/).map((value) => Number(value))
  return width && height ? { source: 'ffprobe', width, height, duration: null } : null
}

// 生产机上不一定有 ffmpeg，所以自己读一眼文件头：只要能证明「横的是横的、几秒」就够了。
// PNG：IHDR 里的宽高（大端 32 位）；
// MP4：moov/trak/tkhd 的宽高是 16.16 定点数，mvhd 的 timescale + duration 算秒。
function probeHeader(buffer, kind) {
  try {
    if (kind === 'image') {
      if (buffer.subarray(1, 4).toString() !== 'PNG' || buffer.subarray(12, 16).toString() !== 'IHDR') return null
      return { source: 'header', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), duration: null }
    }
    const at = buffer.indexOf('tkhd')
    if (at < 0) return null
    const version = buffer[at + 4]
    const width = version === 1 ? buffer.readUInt32BE(at + 92) : buffer.readUInt32BE(at + 80)
    const height = version === 1 ? buffer.readUInt32BE(at + 96) : buffer.readUInt32BE(at + 84)
    let duration = null
    const mv = buffer.indexOf('mvhd')
    if (mv > 0) {
      const mvVersion = buffer[mv + 4]
      const scale = mvVersion === 1 ? buffer.readUInt32BE(mv + 24) : buffer.readUInt32BE(mv + 16)
      const units = mvVersion === 1 ? Number(buffer.readBigUInt64BE(mv + 28)) : buffer.readUInt32BE(mv + 20)
      if (scale > 0 && units > 0) duration = Math.round((units / scale) * 10) / 10
    }
    return { source: 'header', width: width >>> 16, height: height >>> 16, duration }
  } catch {
    return null
  }
}

let opts
try {
  opts = parseArgs(process.argv.slice(2))
} catch (error) {
  console.log('参数不对：' + error.message)
  console.log(USAGE)
  process.exit(2)
}
const user = findUserById(opts.user)
if (!user) throw new Error('找不到这个账号 id')
const session = createSession(user, { userAgent: 'media-verify-once', ip: '127.0.0.1' })
const cookie = 'vq_session=' + encodeURIComponent(session.token)

let exitCode = 0
try {
  const started = Date.now()
  console.log('START kind=' + opts.kind + ' model_ratio=' + opts.ratio +
    (opts.kind === 'video' ? ' duration=' + opts.duration + 's resolution=' + opts.resolution : ''))

  const created = await call(opts.base + '/api/media/generate', cookie, { method: 'POST', body: JSON.stringify(body(opts)) })
  if (created.status !== 200 || !created.json?.task) {
    console.log('FAIL stage=create status=' + created.status + ' body=' + created.text.slice(0, 300))
    exitCode = 1
  } else {
    const task = created.json.task
    console.log('TASK id=' + task.id + ' status=' + task.status + ' cost=' + task.credits.cost +
      ' balance=' + task.credits.balance + ' model=' + task.model + ' ratio_echo=' + (task.ratio || '-') +
      (task.size ? ' size=' + task.size : ''))

    let final = task
    let lastNote = ''
    while (final.status === 'processing') {
      if (Date.now() - started > TIMEOUT_MS[opts.kind]) {
        console.log('TIMEOUT 到点还没结束，停止轮询（任务仍在上游跑）elapsed=' + Math.round((Date.now() - started) / 1000) + 's')
        exitCode = 1
        break
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
      const polled = await call(opts.base + '/api/media/tasks/' + final.id, cookie)
      if (polled.status !== 200 || !polled.json?.task) {
        console.log('WARN 轮询失败 status=' + polled.status + ' body=' + polled.text.slice(0, 200))
        continue
      }
      final = polled.json.task
      const note = 'progress=' + (final.progress === null ? '-' : final.progress + '%') + ' warning=' + (polled.json.warning || '')
      if (note !== lastNote) {
        lastNote = note
        console.log('POLL ' + note)
      }
    }

    const elapsed = Math.round((Date.now() - started) / 1000)
    if (final.status === 'succeeded') {
      const downloaded = await fetch(opts.base + '/api/media/tasks/' + final.id + '/file', { headers: { cookie } })
      if (!downloaded.ok) {
        console.log('FAIL stage=download status=' + downloaded.status)
        exitCode = 1
      } else {
        const buffer = Buffer.from(await downloaded.arrayBuffer())
        fs.writeFileSync(opts.out, buffer)
        const dims = probeFfprobe(opts.out) || probeHeader(buffer, opts.kind)
        console.log('RESULT status=succeeded elapsed=' + elapsed + 's credits=' + final.credits.cost +
          ' refunded=' + final.credits.refunded + ' bytes=' + buffer.length + ' mime=' + final.file.mime +
          ' dims=' + (dims ? dims.width + 'x' + dims.height : '读不出来') +
          ' dur=' + (dims && dims.duration ? dims.duration + 's' : '-') +
          ' via=' + (dims ? dims.source : '-') + ' out=' + opts.out)
      }
    } else {
      console.log('RESULT status=' + final.status + ' elapsed=' + elapsed + 's credits=' + final.credits.cost +
        ' refunded=' + final.credits.refunded + ' error=' + final.error)
      exitCode = 1
    }
  }
} finally {
  destroySession(session.token)
  console.log('SESSION revoked')
}

process.exit(exitCode)