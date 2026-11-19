// 联网搜索（r246）：平台自己搜 + 自己读网页。
// 全程假 fetch / 假搜索服务，不联网、不消耗任何额度。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-web-search-'))
process.env.DATA_DIR = dir
// 测试里的网页地址是 127.0.0.1（假页面），读链接默认会挡住内网地址
process.env.VQ_LINK_ALLOW_PRIVATE = '1'

const { createKey, deleteKey } = await import('../server/keyvault.mjs')

const {
  SEARCH_LIMITS,
  buildQuery,
  clearSearch,
  maskSearchKey,
  normalizeResults,
  readSearch,
  saveSearch,
  searchAndRead,
  searchFile,
  searchView,
  searchWeb,
  validateSearch,
  PLATFORM_PROVIDER,
  deepseekEndpoint,
  platformSearchConfig,
} = await import('../server/web-search.mjs')

const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

const page = (body, title = '测试页') =>
  new Response('<html><head><title>' + title + '</title></head><body>' + body + '</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })

const genericConfig = (endpoint = 'http://127.0.0.1:9/search') => ({ provider: 'generic', key: '', endpoint, enabled: true })

test('拿去搜的问题：去掉网址与 Markdown 记号，取前 80 个字', () => {
  assert.equal(buildQuery('帮我把 https://a.example.com/x 这条口播拆成六个分镜'), '帮我把 这条口播拆成六个分镜')
  assert.equal(buildQuery('## 标题\n\n**加粗** 和 `代码`'), '标题 加粗 和 代码')
  assert.equal(buildQuery('   ，。！  '), '')
  assert.ok(buildQuery('字'.repeat(200)).length <= 80)
  assert.equal(buildQuery('短问题', 3), '短问题')
})

test('三家返回的字段名不一样，都归一成标题 / 地址 / 站点 / 摘要', () => {
  const bocha = { code: 200, data: { webPages: { value: [
    { name: '博查标题', url: 'https://a.example.com/1', snippet: '摘要一' },
    { name: '博查标题二', url: 'https://b.example.com/2', summary: '摘要二' },
  ] } } }
  const rows = normalizeResults('bocha', bocha)
  assert.deepEqual(rows.map((row) => row.title), ['博查标题', '博查标题二'])
  assert.equal(rows[0].site, 'a.example.com')
  assert.equal(rows[1].snippet, '摘要二')

  const tavily = normalizeResults('tavily', { results: [{ title: 'T', url: 'https://t.example.com/x', content: '<p>正文</p>' }] })
  assert.equal(tavily.length, 1)
  assert.equal(tavily[0].snippet, '正文', '摘要里的标签要去掉')
})

test('搜索结果去重、只认 http/https、条数按上限截断、没标题就用域名', () => {
  const rows = normalizeResults('generic', {
    results: [
      { title: '一', url: 'https://a.example.com/1' },
      { title: '重复', url: 'https://a.example.com/1#part' },
      { title: '脚本', url: 'javascript:alert(1)' },
      { url: 'https://b.example.com/2' },
      ...Array.from({ length: 10 }, (_all, index) => ({ title: 'x' + index, url: 'https://c' + index + '.example.com/p' })),
    ],
  }, 3)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].url, 'https://a.example.com/1', '带 # 的算同一条')
  assert.equal(rows[1].title, 'b.example.com', '没标题用域名')
})

test('没有搜索服务时：视图说没接通，搜索如实说「没接入」而不是假装搜过', async () => {
  await clearSearch()
  const view = await searchView()
  assert.equal(view.configured, false)
  assert.equal(view.source, 'none')
  const result = await searchWeb('最新消息')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SEARCH_OFF')
  assert.match(result.note, /还没接入搜索服务/)
  assert.deepEqual(result.results, [])
})

test('保存搜索服务：Key 只回掩码，留空表示沿用旧 Key，通用接口必须填地址', async () => {
  const missingKey = await saveSearch({ provider: 'bocha' })
  assert.equal(missingKey.ok, false)
  assert.match(missingKey.error, /API Key/)
  assert.equal(validateSearch({ provider: 'nope' }).ok, false)
  assert.equal(validateSearch({ provider: 'tavily', endpoint: 'ftp://a/x' }).ok, false)
  assert.equal(validateSearch({ provider: 'generic' }).ok, false, '通用接口不给地址就不行')

  const first = await saveSearch({ provider: 'bocha', key: 'sk-bocha-abcdefg' }, { by: 'admin@example.com' })
  assert.equal(first.ok, true)
  const view = await searchView()
  assert.equal(view.configured, true)
  assert.equal(view.providerLabel, '博查 Bocha')
  assert.equal(view.hasKey, true)
  assert.ok(!JSON.stringify(view).includes('abcdefg'), 'Key 明文不能出现在视图里')
  assert.equal(view.keyMasked, maskSearchKey('sk-bocha-abcdefg'))
  assert.equal(view.updatedBy, 'admin@example.com')

  // 只改服务商之外的字段：Key 留空 = 沿用旧的
  const second = await saveSearch({ provider: 'bocha', endpoint: 'https://proxy.example.com/search?q=' })
  assert.equal(second.ok, true)
  assert.equal(second.keyKept, true)
  assert.equal((await readSearch()).key, 'sk-bocha-abcdefg')

  await clearSearch()
  assert.equal(fs.existsSync(searchFile()), false)
})

test('搜索服务报错、超时、返回非 JSON、返回空、业务码不对：都给人话，不抛异常', async () => {
  const config = genericConfig()
  const http500 = await searchWeb('问题', { config, fetchImpl: async () => json({ error: '额度不足' }, 500) })
  assert.equal(http500.ok, false)
  assert.match(http500.note, /HTTP 500/, http500.note)
  assert.match(http500.note, /额度不足/)

  const timeout = await searchWeb('问题', {
    config,
    fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }) },
  })
  assert.equal(timeout.code, 'SEARCH_FETCH')
  assert.match(timeout.note, /秒内没有响应/)

  const notJson = await searchWeb('问题', { config, fetchImpl: async () => new Response('<html>', { status: 200 }) })
  assert.equal(notJson.code, 'SEARCH_JSON')

  const empty = await searchWeb('问题', { config, fetchImpl: async () => json({ results: [] }) })
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'SEARCH_EMPTY')

  const bochaBad = await searchWeb('问题', {
    config: { provider: 'bocha', key: 'k', endpoint: 'https://search.example.com/q' },
    fetchImpl: async () => json({ code: 403, msg: 'Key 无效' }),
  })
  assert.equal(bochaBad.code, 'SEARCH_CODE')
  assert.match(bochaBad.note, /Key 无效/)

  const huge = await searchWeb('问题', {
    config,
    fetchImpl: async () => new Response('x'.repeat(SEARCH_LIMITS.bytes + 10), { status: 200 }),
  })
  assert.equal(huge.code, 'SEARCH_SIZE')
})

test('各家请求体：博查带 Bearer、Tavily 放 api_key、通用接口只带问题', async () => {
  const seen = []
  const fake = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) })
    return json({ results: [{ title: 'T', url: 'https://t.example.com/x' }] })
  }
  await searchWeb('问题', { config: { provider: 'bocha', key: 'sk-1', endpoint: 'https://b.example.com/s' }, fetchImpl: fake })
  await searchWeb('问题', { config: { provider: 'tavily', key: 'tvly-1', endpoint: 'https://t.example.com/s' }, fetchImpl: fake })
  await searchWeb('问题', { config: genericConfig('https://g.example.com/s'), fetchImpl: fake })
  assert.equal(seen[0].headers.authorization, 'Bearer sk-1')
  assert.equal(seen[0].body.query, '问题')
  assert.equal(seen[0].body.count, SEARCH_LIMITS.results + 2)
  assert.equal(seen[1].body.api_key, 'tvly-1')
  assert.equal(seen[1].body.max_results, SEARCH_LIMITS.results + 2)
  assert.equal(seen[2].body.query, '问题')
  assert.equal(seen[2].headers.authorization, undefined, '通用接口不带 Key')
})

test('搜完再读前几条网页：正文进上下文、读不到的照实说，界面只看来源', async () => {
  const fetchImpl = async (url) => {
    if (url === 'http://127.0.0.1:9/search') {
      return json({ results: [
        { title: '一', url: 'http://127.0.0.1:9/a.html', snippet: '摘要一' },
        { title: '二', url: 'http://127.0.0.1:9/b.html', snippet: '摘要二' },
        { title: '三', url: 'http://127.0.0.1:9/c.html', snippet: '摘要三' },
        { title: '四', url: 'http://127.0.0.1:9/d.html', snippet: '摘要四' },
      ] })
    }
    if (url.endsWith('/a.html')) return page('<p>' + '第一页的正文，'.repeat(12) + '</p>', '第一页')
    if (url.endsWith('/b.html')) return page('<p>' + '第二页的正文，'.repeat(12) + '</p>', '第二页')
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } })
  }
  const result = await searchAndRead('最近有什么变化', { config: genericConfig(), fetchImpl })
  assert.equal(result.search.ok, true)
  assert.equal(result.search.results.length, 4)
  assert.equal(result.links.length, SEARCH_LIMITS.readTop, '只读前 3 条')
  assert.match(result.text, /【联网搜索：最近有什么变化（平台自己搜的，来源 /)
  assert.match(result.text, /1\. 一｜127\.0\.0\.1｜http:\/\/127\.0\.0\.1:9\/a\.html/)
  assert.match(result.text, /第一页的正文/, '读到网页正文')
  assert.match(result.text, /没读到/, '读不到的那条照实说')
  assert.equal(result.links[2].ok, false)
})

test('搜索没成时上下文里写的是「别编」：不是空的、也不假装搜过', async () => {
  const config = genericConfig()
  const result = await searchAndRead('最近有什么变化', {
    config,
    fetchImpl: async () => json({ error: 'boom' }, 500),
  })
  assert.equal(result.search.ok, false)
  assert.match(result.text, /联网搜索没有成功/)
  assert.match(result.text, /不要编造链接或数据/)
  assert.deepEqual(result.links, [])
})

test('DeepSeek 搜索跟平台对话共用一把 Key：没有平台 Key 不许开通，开了也不另存一份', async () => {
  await clearSearch()
  const refused = await saveSearch({ provider: 'deepseek' })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /还没配/)
  assert.match(refused.error, /Key 池/)

  // 平台对话那把 Key：一条 DeepSeek Key，声明文本能力（别的能力不参与搜索）
  const created = createKey({
    name: '平台对话',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-platform-deepseek-0001',
    capabilities: ['text'],
  })
  try {
    const saved = await saveSearch({ provider: 'deepseek' }, { by: 'admin@example.com' })
    assert.equal(saved.ok, true)
    assert.equal(saved.platformKeySource, 'pool')
    assert.equal((await readSearch()).key, '', '共用 Key：search.json 里一个 Key 都不存')

    const view = await searchView()
    assert.equal(view.configured, true)
    assert.equal(view.provider, PLATFORM_PROVIDER)
    assert.equal(view.usesPlatformKey, true)
    assert.equal(view.platformKey.available, true)
    assert.equal(view.platformKey.source, 'pool')
    assert.equal(view.platformKey.masked, maskSearchKey('sk-platform-deepseek-0001'))
    assert.ok(!JSON.stringify(view).includes('sk-platform-deepseek-0001'), '平台 Key 明文不能出现在接口里')

    assert.equal(deepseekEndpoint('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/tools/search')
    assert.equal(deepseekEndpoint('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/tools/search')
    assert.equal(platformSearchConfig()?.source, 'pool')
  } finally {
    await clearSearch()
    deleteKey(created.id)
  }
  assert.equal(platformSearchConfig(), null, '删掉平台 Key 之后就没有可共用的 Key 了')
  assert.equal((await searchView()).platformKey.available, false)
})

test('DeepSeek 搜索：请求打到 /v1/tools/search，结构化结果按标题 / 地址 / 站点 / 摘要归一', async () => {
  const created = createKey({
    name: '平台对话',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-platform-deepseek-0002',
    capabilities: ['text'],
  })
  try {
    const saved = await saveSearch({ provider: 'deepseek' })
    assert.equal(saved.ok, true)
    const seen = []
    const fake = async (url, init) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body) })
      return json({
        results: [
          { title: '爆款结构', url: 'https://a.example.com/1', snippet: '界面用短摘要', summary: '模型读的长摘要：前三秒给冲突', site_name: '示例号', rerank_score: 2.4 },
          { title: '同一条', url: 'https://a.example.com/1#part', summary: '重复地址' },
          { title: '', url: 'https://b.example.com/2', snippet: '没有摘要' },
        ],
      })
    }
    const result = await searchWeb('短视频 爆款 结构', { fetchImpl: fake })
    assert.equal(result.ok, true)
    assert.equal(result.provider, 'deepseek')
    assert.equal(seen[0].url, 'https://api.deepseek.com/v1/tools/search')
    assert.equal(seen[0].headers.authorization, 'Bearer sk-platform-deepseek-0002')
    assert.equal(seen[0].body.query, '短视频 爆款 结构')
    assert.equal(seen[0].body.count, SEARCH_LIMITS.results + 2)
    assert.equal(seen[0].body.need_content, false, '正文我们自己读，不重复买一次')
    assert.equal(result.results.length, 2, '带 # 的算同一条')
    assert.deepEqual(result.results[0], {
      title: '爆款结构',
      url: 'https://a.example.com/1',
      site: '示例号',
      snippet: '模型读的长摘要：前三秒给冲突',
    })
    assert.equal(result.results[1].title, 'b.example.com', '没标题用域名')
  } finally {
    await clearSearch()
    deleteKey(created.id)
  }
})

test('DeepSeek 搜索出错：401/402/400 说清是 Key、余额还是请求，不把上游的英文原文丢给用户', async () => {
  const config = { provider: 'deepseek', key: 'sk-x', endpoint: 'https://api.deepseek.com/v1/tools/search', enabled: true }
  const unauthorized = await searchWeb('问题', { config, fetchImpl: async () => json({ error: { message: 'invalid key' } }, 401) })
  assert.equal(unauthorized.code, 'SEARCH_KEY')
  assert.match(unauthorized.note, /Key 池/)

  const poor = await searchWeb('问题', { config, fetchImpl: async () => new Response('{}', { status: 402 }) })
  assert.equal(poor.code, 'SEARCH_BALANCE')
  assert.match(poor.note, /余额/)

  const bad = await searchWeb('问题', {
    config,
    fetchImpl: async () => json({ error: { message: "'count' must be between 1 and 50" } }, 400),
  })
  assert.equal(bad.code, 'SEARCH_REQUEST')
  assert.match(bad.note, /count/)
})

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})
