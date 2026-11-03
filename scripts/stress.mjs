#!/usr/bin/env node
// 压力测试脚本：只打本地 API，不直接调红狐；不包含任何密钥。
// 用法：node scripts/stress.mjs --test=search|reuse|replicate|edge [--n=20]
const args = Object.fromEntries(process.argv.slice(2).map((item) => {
  const [key, value] = item.replace(/^--/, '').split('=')
  return [key, value ?? 'true']
}))
const BASE = args.base || process.env.API_BASE || 'http://127.0.0.1:8787'
const N = Number(args.n || 20)
const TEST = args.test || 'search'

const VIDEOS = [
  { name: 'BBB 360 10s', url: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4' },
  { name: 'Jellyfish 10s', url: 'https://test-videos.co.uk/vids/jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4' },
  { name: 'Sintel 10s', url: 'https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4' },
  { name: 'BBB 720 10s', url: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4' },
  { name: 'MDN flower 5s', url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4' },
]

const json = async (path, init) => {
  const response = await fetch(BASE + path, { headers: { 'Content-Type': 'application/json' }, ...init })
  const text = await response.text()
  try { return { status: response.status, body: JSON.parse(text) } } catch { return { status: response.status, body: { raw: text.slice(0, 200) } } }
}

const percentile = (values, p) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

async function timed(fn) {
  const start = Date.now()
  try { const value = await fn(); return { ok: true, ms: Date.now() - start, value } }
  catch (error) { return { ok: false, ms: Date.now() - start, error: String(error?.message || error) } }
}

async function searchTest() {
  const keywords = ['通勤穿搭', '咖啡', '租房改造', '护肤', '早餐', '春招']
  const tasks = Array.from({ length: N }, (_, index) => timed(async () => {
    const keyword = encodeURIComponent(keywords[index % keywords.length])
    const r = await json('/api/search?platform=all&q=' + keyword)
    return { status: r.status, mode: r.body.mode, total: r.body.total, quota: Boolean(r.body.quota) }
  }))
  const results = await Promise.all(tasks)
  const ok = results.filter((item) => item.ok)
  const statuses = {}
  const modes = {}
  for (const item of ok) {
    statuses[item.value.status] = (statuses[item.value.status] || 0) + 1
    modes[item.value.mode] = (modes[item.value.mode] || 0) + 1
  }
  return {
    test: 'search',
    concurrency: N,
    success: ok.length,
    failed: results.length - ok.length,
    http: statuses,
    modes,
    latency: { p50: percentile(ok.map((i) => i.ms), 50), p95: percentile(ok.map((i) => i.ms), 95), max: Math.max(...ok.map((i) => i.ms)) },
    errors: results.filter((i) => !i.ok).map((i) => i.error).slice(0, 3),
  }
}

async function reuseTest() {
  const list = await json('/api/templates')
  const target = list.body.items?.[0]
  if (!target) throw new Error('模板库为空，先跑一次复刻')
  const before = target.reuseCount
  const results = await Promise.all(Array.from({ length: N }, () => timed(() => json('/api/templates/' + target.id + '/reuse', { method: 'POST' }))))
  const after = await json('/api/templates/' + target.id)
  return {
    test: 'reuse',
    templateId: target.id,
    concurrency: N,
    success: results.filter((item) => item.ok).length,
    reuseBefore: before,
    reuseAfter: after.body.reuseCount,
    expected: before + N,
    lostUpdates: before + N - after.body.reuseCount,
  }
}

async function replicateTest() {
  const started = []
  const t0 = Date.now()
  for (let index = 0; index < N; index += 1) {
    const video = VIDEOS[index % VIDEOS.length]
    const start = Date.now()
    const r = await json('/api/replicate', {
      method: 'POST',
      body: JSON.stringify({ url: video.url, item: { id: 'stress-' + index, platform: 'douyin', platformLabel: '抖音', title: video.name, stats: { likes: 0, comments: 0, shares: 0, collects: 0 } } }),
    })
    started.push({ jobId: r.body.jobId, video: video.name, startMs: start })
  }
  const finished = []
  const deadline = Date.now() + 15 * 60 * 1000
  while (finished.length < started.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    for (const job of started) {
      if (job.done) continue
      const r = await json('/api/jobs/' + job.jobId)
      const body = r.body
      if (body.status === 'done' || body.status === 'error') {
        job.done = true
        finished.push({ jobId: job.jobId, video: job.video, status: body.status, seconds: Math.round((Date.now() - job.startMs) / 1000), error: body.error || null, templateId: body.templateId || null })
      }
    }
    if (!started.length) break
  }
  const done = finished.filter((item) => item.status === 'done')
  return {
    test: 'replicate',
    jobs: started.length,
    done: done.length,
    failed: finished.filter((item) => item.status !== 'done').map((item) => ({ video: item.video, error: item.error })),
    totalSeconds: Math.round((Date.now() - t0) / 1000),
    perJob: finished.map((item) => ({ video: item.video, status: item.status, seconds: item.seconds, error: item.error })),
  }
}

async function edgeTest() {
  const cases = [
    { name: '无参数复刻', body: { item: { id: 'x' } } },
    { name: '无效 URL', body: { url: 'https://example.com/not-a-video' } },
    { name: '404 视频', body: { url: 'https://test-videos.co.uk/nope.mp4' } },
    { name: '非视频内容', body: { url: 'https://example.com/' } },
    { name: '不存在的任务', path: '/api/jobs/does-not-exist' },
    { name: '不存在的模板', path: '/api/templates/tpl_missing' },
  ]
  const results = []
  for (const item of cases) {
    if (item.path) {
      const r = await json(item.path)
      results.push({ case: item.name, status: r.status, body: JSON.stringify(r.body).slice(0, 120) })
      continue
    }
    const r = await json('/api/replicate', { method: 'POST', body: JSON.stringify(item.body) })
    if (r.body.jobId) {
      let job = null
      for (let i = 0; i < 40; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        const poll = await json('/api/jobs/' + r.body.jobId)
        if (poll.body.status !== 'running') { job = poll.body; break }
      }
      results.push({ case: item.name, status: r.status, jobStatus: job?.status || 'timeout', error: job?.error || null })
    } else {
      results.push({ case: item.name, status: r.status, body: JSON.stringify(r.body).slice(0, 120) })
    }
  }
  return { test: 'edge', results }
}

const run = { search: searchTest, reuse: reuseTest, replicate: replicateTest, edge: edgeTest }[TEST]
if (!run) {
  console.error('未知测试：' + TEST)
  process.exit(1)
}
const result = await run()
console.log(JSON.stringify(result, null, 2))
