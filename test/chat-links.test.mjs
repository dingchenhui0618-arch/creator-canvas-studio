// 读链接（r219）：页面读成文字、内网挡住、单个链接失败不影响这次对话。
// 全程用假 fetch / 假 DNS，不联网、不消耗任何额度。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-chat-links-'))
process.env.DATA_DIR = dir

const { assertPublicUrl, contentTypeKind, findLinks, htmlToText, isPrivateAddress, pageTitle, readLink, readLinks } =
  await import('../server/link-read.mjs')

const publicLookup = async () => [{ address: '93.184.216.34' }]

function html(body, init = {}) {
  return new Response('<html><head><title>' + (init.title || '测试页') + '</title><style>p{color:red}</style></head><body>' + body + '</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

test('HTML 变文字：脚本、样式、注释都去掉，段落还原成换行，实体解码', () => {
  const text = htmlToText(
    '<div><!-- 广告 --><script>var a = 1</script><p>开场三秒要抓人</p><p>第二段 &amp; 结尾</p><br/><span>第三段</span></div>',
  )
  assert.ok(!text.includes('var a'), '脚本内容不该进正文')
  assert.ok(!text.includes('广告'), '注释不该进正文')
  assert.match(text, /开场三秒要抓人\n+第二段 & 结尾/)
  assert.match(text, /第三段/)
})

test('页面标题单独取出来，最长 80 字', () => {
  assert.equal(pageTitle('<html><head><title> 三条口播测试 \n</title>'), '三条口播测试')
  assert.equal(pageTitle('<html><head></head>'), '')
})

test('只认 http/https 的链接片段：句尾标点去掉、重复的只留一条', () => {
  const found = findLinks('看这个 https://a.example.com/x 和 http://b.example.com/y?q=1，还有 https://a.example.com/x。')
  assert.deepEqual(found, ['https://a.example.com/x', 'http://b.example.com/y?q=1'])
  assert.deepEqual(findLinks('没有链接的一句话'), [])
})

test('内网地址矩阵：本机、局域网、链路本地、CGNAT、组播、IPv6 都算内网', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(address), true, address + ' 应该被当成内网')
  }
  for (const address of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1::1']) {
    assert.equal(isPrivateAddress(address), false, address + ' 是公网地址')
  }
})

test('地址校验：字面内网、跳到内网的域名、非 http 协议、带账号口令都拒绝', async () => {
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1:8080/x', { lookup: publicLookup }), (error) => error.code === 'LINK_PRIVATE')
  await assert.rejects(() => assertPublicUrl('http://localhost/x', { lookup: async () => [{ address: '127.0.0.1' }] }), (error) => error.code === 'LINK_PRIVATE')
  await assert.rejects(() => assertPublicUrl('ftp://a.example.com/x', { lookup: publicLookup }), (error) => error.code === 'LINK_SCHEME')
  await assert.rejects(() => assertPublicUrl('https://user:pass@a.example.com/x', { lookup: publicLookup }), (error) => error.code === 'LINK_URL')
  assert.equal(await assertPublicUrl('https://a.example.com/x', { lookup: publicLookup }), 'https://a.example.com/x')
})

test('读一个正常网页：标题、正文、字数都对，脚本不进正文', async () => {
  const fetchImpl = async () => html('<p>' + '开场三秒要抓人，'.repeat(10) + '</p><script>evil()</script>')
  const page = await readLink('https://a.example.com/x', { fetchImpl, lookup: publicLookup })
  assert.equal(page.title, '测试页')
  assert.equal(page.ok, true)
  assert.ok(page.chars > 40)
  assert.ok(!page.text.includes('evil'))
  assert.equal(page.truncated, false)
})

test('跳转目标也要重新校验：公网跳进内网一律挡住', async () => {
  const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
  await assert.rejects(() => readLink('https://a.example.com/jump', { fetchImpl, lookup: publicLookup }), (error) => error.code === 'LINK_PRIVATE')
})

test('读不到的几种：不是网页、HTTP 404、正文太少，都给人话', async () => {
  const binary = async () => new Response(Buffer.from([0x50, 0x4b, 0x03, 0x04]), { status: 200, headers: { 'content-type': 'application/zip' } })
  await assert.rejects(() => readLink('https://a.example.com/a.zip', { fetchImpl: binary, lookup: publicLookup }), (error) => error.code === 'LINK_TYPE')
  const missing = async () => new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } })
  await assert.rejects(() => readLink('https://a.example.com/404', { fetchImpl: missing, lookup: publicLookup }), (error) => /HTTP 404/.test(error.message))
  const empty = async () => new Response('<html><body><div id="app"></div></body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
  await assert.rejects(() => readLink('https://a.example.com/spa', { fetchImpl: empty, lookup: publicLookup }), (error) => error.code === 'LINK_EMPTY')
})

test('页面太长按上限截断，并标「已截断」', async () => {
  const long = async () => html('<p>' + '字'.repeat(5000) + '</p>')
  const page = await readLink('https://a.example.com/long', { fetchImpl: long, lookup: publicLookup, maxChars: 200 })
  assert.equal(page.truncated, true)
  assert.equal(page.chars, 200)
  assert.ok(page.note.includes('太长'))
})

test('两个链接一次读：好的照读，坏的不拖垮，最多读两个', async () => {
  const pages = {
    'https://a.example.com/ok': html('<p>' + '这是第一页的正文，'.repeat(10) + '</p>'),
    'https://b.example.com/ok': html('<p>' + '这是第二页的正文，'.repeat(10) + '</p>'),
  }
  const fetchImpl = async (url) => {
    if (pages[url]) return pages[url]
    return new Response('boom', { status: 500, headers: { 'content-type': 'text/plain' } })
  }
  const result = await readLinks(
    ['https://a.example.com/ok', 'https://c.example.com/bad', 'https://b.example.com/ok'],
    { fetchImpl, lookup: publicLookup },
  )
  assert.equal(result.links.length, 2, '一次最多读两个')
  assert.equal(result.links[0].ok, true)
  assert.equal(result.links[1].ok, false)
  assert.match(result.links[1].note, /HTTP 500/)
  assert.match(result.text, /【链接 1：https:\/\/a\.example\.com\/ok（测试页）/, '读到的链接要有标题')
  assert.match(result.text, /【链接 2：https:\/\/c\.example\.com\/bad 没读到：/)
})

test('content-type 归类：网页 / PDF / 纯文本认得，压缩包与图片不认', () => {
  assert.equal(contentTypeKind('text/html; charset=utf-8'), 'html')
  assert.equal(contentTypeKind('application/pdf'), 'pdf')
  assert.equal(contentTypeKind('text/plain'), 'text')
  assert.equal(contentTypeKind('application/json'), 'text')
  assert.equal(contentTypeKind('application/zip'), '')
  assert.equal(contentTypeKind('image/png'), '')
})

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})
