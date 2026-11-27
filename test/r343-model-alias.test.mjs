// r343：普通用户能看到的接口里不许出现上游厂牌与内部型号（界面、DevTools、响应体都算）。
//
// 为什么单独一组：模型 id 以前就是配置里的原名（deepseek-flash 这类），界面上标签是产品名、
// id 却直接透出上游——「界面看着干净」不等于「用户看不到」。这里把口子钉在三处：
// 清单本身、偏好读写、以及改名之后老数据（内部名）还能不能用。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-model-alias-'))
process.env.DATA_DIR = DATA_DIR
process.env.VQ_KEY_SECRET = 'test-secret-model-alias'
process.env.VQ_REQUIRE_AUTH = '1'

const auth = await import('../server/auth.mjs')
const { modelCatalog, publicModelName, internalModelName } = await import('../server/models.mjs')
const { config } = await import('../server/config.mjs')
const { createPreferencesRouter } = await import('../server/routes/preferences.mjs')

// 厂牌词表：命中任意一个就说明内部名字漏到接口上了
const VENDOR = /deepseek|openai|anthropic|claude|gemini|qwen|doubao|volcengine|火山|moonshot|zhipu|glm|minimax|grok|xai|seedream|kling|codex|workbuddy/i
// 内部型号形态：xxx-flash / xxx-pro 这类一下就能搜到上游的写法
const MODELISH = /[a-z0-9]-(flash|pro|turbo|luna|mini)\b/i

const AT = String.fromCharCode(64)
const mail = (name) => name + AT + 'vq.test'
const PASS = 'Passw0rd!demo'

const user = auth.createUser({ email: mail('alias'), password: PASS, name: '甲', kind: 'account' })
const cookie = auth.sessionCookie(auth.createSession(user, { userAgent: 'test', ip: '10.0.0.1' }).token).split(';')[0]

function mockReq({ method = 'GET', body = null } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = { cookie }
  req.socket = { remoteAddress: '127.0.0.1' }
  req.once = () => {}
  if (body !== null) req.push(JSON.stringify(body))
  req.push(null)
  return req
}

function mockRes() {
  const parts = []
  return {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    writeHead(code, headers) {
      this.statusCode = code
      Object.assign(this.headers, headers || {})
    },
    setHeader(name, value) {
      this.headers[name] = value
    },
    write(chunk) {
      if (chunk) parts.push(chunk)
      return true
    },
    end(chunk) {
      if (chunk) parts.push(chunk)
      this.writableEnded = true
    },
    body() {
      return Buffer.concat(parts.map((item) => (Buffer.isBuffer(item) ? item : Buffer.from(String(item))))).toString('utf8')
    },
    json() {
      const text = this.body()
      return text ? JSON.parse(text) : null
    },
  }
}

const router = createPreferencesRouter()
async function call({ method = 'GET', pathname, body = null } = {}) {
  const res = mockRes()
  const url = new URL('http://127.0.0.1' + pathname)
  const handled = await router.handle(mockReq({ method, body }), res, url, pathname)
  assert.equal(handled, true, '偏好路由应当认领 ' + method + ' ' + pathname)
  return res
}

test('模型清单的 id 全是产品名：没有厂牌、没有内部型号', () => {
  const catalog = modelCatalog()
  assert.ok(catalog.models.length > 0, '至少有一个模型，否则这条测试什么也没验到')
  for (const item of catalog.models) {
    assert.match(item.id, /^visionqa-(chat|vision|general)(-\d+)?$/, '对外 id 必须是产品名，实际 ' + item.id)
    assert.equal(VENDOR.test(item.id), false, 'id 里不该有厂牌：' + item.id)
    assert.equal(VENDOR.test(item.label), false, '标签里不该有厂牌：' + item.label)
    assert.equal(MODELISH.test(item.id), false, 'id 里不该有内部型号写法：' + item.id)
  }
  // 整个响应体一起看：current / textModel / visionModel 以前就是配置里的原名
  const dump = JSON.stringify(catalog)
  assert.equal(VENDOR.test(dump), false, '整份清单里不该出现厂牌：' + dump.slice(0, 200))
  assert.equal(MODELISH.test(dump.replace(/"hint":[^}]*/, '')), false, '整份清单里不该出现内部型号')
  for (const key of ['current', 'textModel', 'visionModel']) {
    const value = String(catalog[key] || '')
    if (!value) continue
    assert.match(value, /^visionqa-(chat|vision|general)(-\d+)?$/, key + ' 也必须是产品 id，实际 ' + value)
  }
})

test('双向映射：产品 id 能换回内部名，老数据里的内部名也认，画布/媒体模型原样放过', () => {
  const internal = config.llm.model
  const publicId = publicModelName(internal)
  assert.match(publicId, /^visionqa-/, '内部名应当映射成产品 id，实际 ' + publicId)
  assert.equal(internalModelName(publicId), internal, '产品 id 必须能换回内部名，否则切模型会失效')
  // 老数据：偏好、智能体记录里存的是改名前的内部名，不能因为改名就认不出来
  assert.equal(internalModelName(internal), internal)
  // 画布与快捷创作的图片 / 视频模型本来就是产品名，别在这里二次包装
  assert.equal(publicModelName('visionqa-image-1'), 'visionqa-image-1')
  assert.equal(internalModelName('visionqa-image-1'), 'visionqa-image-1')
  // 认不出来的原样返回：宁可让它去上游报错，也不要静默换成另一个模型
  assert.equal(internalModelName('some-unknown-model'), 'some-unknown-model')
  assert.equal(publicModelName(''), '')
})

test('同一类里多个模型：第一个不加序号，后面按 -2 / -3 递增，全程不重复', () => {
  const backup = process.env.VISION_MODELS
  try {
    // 用服务端自己的清单拼一份「肯定多个模型」的显式清单，逼出同能力多模型的分支
    process.env.VISION_MODELS = [config.llm.model, ...config.llm.fallbacks, ...config.vision.fallbacks, config.vision.model]
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .filter((item, index, all) => all.indexOf(item) === index)
      .join(',')
    const catalog = modelCatalog()
    const ids = catalog.models.map((item) => item.id)
    assert.equal(new Set(ids).size, ids.length, 'id 不该重复：' + ids.join(','))

    // 按「去掉序号后的基名」分组：每组应当是 base、base-2、base-3… 顺序编号
    const groups = new Map()
    for (const item of catalog.models) {
      const base = item.id.replace(/-\d+$/, '')
      groups.set(base, [...(groups.get(base) || []), item])
    }
    assert.ok(groups.size > 0, '至少要有一组')
    for (const [base, list] of groups) {
      assert.match(base, /^visionqa-(chat|vision|general)$/, '基名必须是产品名，实际 ' + base)
      list.forEach((item, index) => {
        assert.equal(item.id, index === 0 ? base : base + '-' + (index + 1), '同类第 ' + (index + 1) + ' 个的 id 不对：' + item.id)
      })
    }
    assert.equal(VENDOR.test(JSON.stringify(catalog)), false, '显式清单同样不许带厂牌')
    assert.equal(MODELISH.test(JSON.stringify(catalog).replace(/"hint":[^}]*/, '')), false, '显式清单同样不许带内部型号')
  } finally {
    if (backup === undefined) delete process.env.VISION_MODELS
    else process.env.VISION_MODELS = backup
  }
})

test('联网搜索的来源也只给产品口径：界面与响应体里没有厂牌名', async () => {
  const { publicSearch } = await import('../server/web-search.mjs')
  const view = publicSearch({
    ok: true,
    query: '最近有什么新变化',
    provider: 'deepseek',
    providerLabel: 'DeepSeek 搜索（跟平台对话共用一把 Key）',
    results: [{ title: '结果一', url: 'https://example.com/a', site: 'example.com' }],
  })
  assert.equal(view.providerLabel, '平台搜索', '界面这一侧只认产品口径')
  assert.equal(view.provider, 'platform')
  assert.equal(VENDOR.test(JSON.stringify(view)), false, '搜索结果里不该出现厂牌：' + JSON.stringify(view))
  // 结果本身照旧给（标题 / 站点 / 地址），只是不带通道信息
  assert.equal(view.results[0].title, '结果一')
})

test('偏好接口：传内部名直接用 400 挡住，传产品 id 存得进也读得回产品 id', async () => {
  const publicId = modelCatalog().models[0].id
  const rejected = await call({ method: 'PUT', pathname: '/api/preferences', body: { model: config.llm.model } })
  assert.equal(rejected.statusCode, 400, '内部模型名不是可用列表里的值，该 400')
  const body = rejected.json()
  assert.equal(VENDOR.test(JSON.stringify(body)), false, '400 的可用列表里也不许带厂牌')

  const saved = await call({ method: 'PUT', pathname: '/api/preferences', body: { model: publicId } })
  assert.equal(saved.statusCode, 200)
  assert.equal(saved.json().model, publicId, '存完回给界面的仍是产品 id')

  const read = await call({ pathname: '/api/preferences' })
  assert.equal(read.statusCode, 200)
  assert.equal(read.json().model, publicId, '读回来也必须是产品 id，不能把内部名漏出去')
})
