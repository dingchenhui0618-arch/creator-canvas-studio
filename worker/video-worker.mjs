#!/usr/bin/env node
// 远端算力参考实现：把「解析 → 下载 → 探测 → 抽帧」放到另一台机器上跑。
// 我们的工作台只调这里拿 meta + 帧，本地不跑 ffmpeg。
//
// 启动：WORKER_TOKEN=xxx node worker/video-worker.mjs        （默认 8790）
// 契约：见 docs/remote-compute.md

import http from 'node:http'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { probeVideo, detectSceneCuts, planTimestamps, extractFrames } from '../server/frames.mjs'

const PORT = Number(process.env.WORKER_PORT || 8790)
const TOKEN = (process.env.WORKER_TOKEN || '').trim()
const MAX_MB = Number(process.env.WORKER_MAX_MB || 200)
const MAX_FRAMES = Number(process.env.WORKER_MAX_FRAMES || 18)
const TIMEOUT_MS = Number(process.env.WORKER_TIMEOUT_MS || 120000)

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

function readBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// 只接受 http(s) 与 file:，避免把 worker 变成任意文件读取器
async function acquire(url, dir) {
  if (url.startsWith('file://')) {
    const filePath = decodeURIComponent(url.slice('file://'.length))
    const stat = await fsp.stat(filePath)
    if (!stat.isFile()) throw new Error('file:// 目标不是文件')
    if (stat.size > MAX_MB * 1024 * 1024) throw new Error('视频超过 ' + MAX_MB + 'MB 上限')
    return filePath
  }
  if (!/^https?:\/\//i.test(url)) throw new Error('只支持 http(s) 或 file:// 的视频地址')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'visionqa-worker/0.1' } })
    if (!response.ok) throw new Error('下载失败 HTTP ' + response.status)
    const length = Number(response.headers.get('content-length') || 0)
    if (length > MAX_MB * 1024 * 1024) throw new Error('视频超过 ' + MAX_MB + 'MB 上限')
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > MAX_MB * 1024 * 1024) throw new Error('视频超过 ' + MAX_MB + 'MB 上限')
    const target = path.join(dir, 'source.mp4')
    await fsp.writeFile(target, buffer)
    return target
  } finally {
    clearTimeout(timer)
  }
}

async function handleReplicate(body) {
  const url = String(body.url || '').trim()
  if (!url) throw new Error('缺少 url')
  const maxFrames = Math.max(4, Math.min(MAX_FRAMES, Number(body.maxFrames || MAX_FRAMES)))
  const started = Date.now()
  const dir = path.join(os.tmpdir(), 'vq-worker-' + randomUUID().slice(0, 8))
  await fsp.mkdir(dir, { recursive: true })
  try {
    const file = await acquire(url, dir)
    const meta = await probeVideo(file)
    if (!meta.duration) throw new Error('视频时长读取失败')
    const cuts = await detectSceneCuts(file)
    const timestamps = planTimestamps(meta.duration, cuts, maxFrames)
    const frameDir = path.join(dir, 'frames')
    const extracted = await extractFrames(file, frameDir, timestamps, () => {})
    const frames = []
    for (const frame of extracted) {
      const buffer = await fsp.readFile(frame.file)
      frames.push({ t: frame.t, base64: buffer.toString('base64') })
    }
    return { ok: true, meta, cuts, frames, tookMs: Date.now() - started }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    return json(res, 200, { ok: true, service: 'visionqa-video-worker', provider: 'local-ffmpeg', maxFrames: MAX_FRAMES, maxMb: MAX_MB })
  }
  if (req.method !== 'POST' || url.pathname !== '/replicate') return json(res, 404, { ok: false, error: 'not found' })
  if (TOKEN && (req.headers.authorization || '') !== 'Bearer ' + TOKEN) return json(res, 401, { ok: false, error: 'token 不匹配' })
  try {
    const body = JSON.parse((await readBody(req)) || '{}')
    const result = await handleReplicate(body)
    return json(res, 200, result)
  } catch (error) {
    return json(res, 400, { ok: false, error: String(error?.message || error) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('[worker] listening on http://127.0.0.1:' + PORT)
})
