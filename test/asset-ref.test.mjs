// 资产引用（r312）：一个字符串引用要真的能换成「这次生成可用的参考图字节」。
// 这一组只碰纯函数与磁盘上的假资产，不调任何上游、不扣积分。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-asset-ref-'))
process.env.DATA_DIR = dir

const OWNER = 'u_asset_ref_test'
const OTHER = 'u_asset_ref_other'
const ASSET_ID = 'asst_mtest01_abcd12'
const TOKEN = ASSET_ID + ':hero'

// 1×1 PNG：真实可解析，缩图层能正常探测；读不出来也不影响引用这一层的断言。
const tinyPng = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
  'hex',
)

function writeAsset(ownerId, id, { kind = 'product', name = '美式咖啡机', status = 'ready', refs = [] } = {}) {
  const root = path.join(dir, 'assets', ownerId, id)
  fs.mkdirSync(root, { recursive: true })
  const now = '2026-11-20T10:00:00.000Z'
  const metaRefs = refs.map((ref) => {
    const file = ref.slot + '.png'
    fs.writeFileSync(path.join(root, file), tinyPng)
    return { slot: ref.slot, label: ref.label, file, mime: 'image/png', width: 1, height: 1, bytes: tinyPng.length, createdAt: now }
  })
  fs.writeFileSync(path.join(root, 'meta.json'), JSON.stringify({
    version: 1,
    id,
    ownerId,
    kind,
    name,
    category: '',
    status,
    progress: { done: metaRefs.length, total: 4 },
    sources: [],
    refs: metaRefs,
    error: '',
    free: false,
    createdAt: now,
    updatedAt: now,
  }, null, 2))
  return root
}

const heroRef = { slot: 'hero', label: '白底主图' }
const sceneRef = { slot: 'scene', label: '场景图' }
writeAsset(OWNER, ASSET_ID, { refs: [heroRef, sceneRef] })
const avatarRoot = writeAsset(OWNER, 'asst_mtest02_beef34', { kind: 'avatar', name: '小林', status: 'partial', refs: [{ slot: 'front', label: '正面定妆' }] })
writeAsset(OWNER, 'asst_mtest03_cafe56', { status: 'draft', refs: [heroRef] })
writeAsset(OWNER, 'asst_mtest04_d00d78', { refs: [] })

const refs = await import('../server/asset-ref.mjs')

test('引用格式：只认 asst_<ts>_<hex>:<slot>，非法值归一成空串而不是抛错', () => {
  assert.equal(refs.normalizeAssetRef(TOKEN), TOKEN)
  assert.equal(refs.normalizeAssetRef('  ' + TOKEN + '  '), TOKEN, '前后空格要能去掉')
  assert.equal(refs.normalizeAssetRef('asset:' + TOKEN), '', 'asset: 前缀只在前端选择器里用，引用本身不含它')
  assert.equal(refs.normalizeAssetRef(''), '')
  assert.equal(refs.normalizeAssetRef(null), '')
  assert.equal(refs.normalizeAssetRef('asst_short_abcd12:hero'), '', '时间戳段太短')
  assert.equal(refs.normalizeAssetRef(ASSET_ID + ':HERO'), '', '槽位名只认小写')
  assert.equal(refs.normalizeAssetRef(ASSET_ID + ':he'), '', '槽位名至少 3 位')
  assert.equal(refs.splitAssetRef('not-a-ref'), null)
  assert.deepEqual(refs.splitAssetRef(TOKEN), { assetId: ASSET_ID, slot: 'hero' })
  assert.equal(refs.assetRefToken(ASSET_ID, 'hero'), TOKEN)
  assert.equal(refs.assetRefToken('bad', 'hero'), '', '拼不出合法引用就回空串')
  assert.equal(refs.assetRefToken(ASSET_ID, 'Hero'), '')
})

test('人话标签：产品与数字人的槽位都写清楚，界面上才能看出用的是哪一张', () => {
  assert.equal(refs.assetRefLabel({ kind: 'product', name: '美式咖啡机' }, 'hero'), '产品「美式咖啡机」· 白底主图')
  assert.equal(refs.assetRefLabel({ kind: 'avatar', name: '小林' }, 'front'), '数字人「小林」· 正面定妆')
  assert.equal(refs.assetRefLabel({ kind: 'avatar', name: '' }, 'front'), '数字人「未命名资产」· 正面定妆')
})

test('读自己的资产：归属、槽位、标签与字节都对得上', async () => {
  const found = await refs.readAssetReference(OWNER, TOKEN)
  assert.equal(found.token, TOKEN)
  assert.equal(found.assetId, ASSET_ID)
  assert.equal(found.slot, 'hero')
  assert.equal(found.kind, 'product')
  assert.equal(found.name, '美式咖啡机')
  assert.equal(found.label, '产品「美式咖啡机」· 白底主图')
  assert.ok(found.buffer.length > 0, '必须真的读出字节，不能只回一个文件名')
  assert.match(found.filename, /^asset\.(png|jpg)$/)
  assert.ok(['image/png', 'image/jpeg'].includes(found.mime))
  // 没生成出来的槽位：写进节点能存，但读的时候必须失败
  await assert.rejects(
    () => refs.readAssetReference(OWNER, ASSET_ID + ':pack'),
    (error) => error.status === 400 && error.code === 'ASSET_REF_MISSING',
  )
})

test('别人的资产当作不存在：不解释它有没有，只回 ASSET_REF_MISSING', async () => {
  await assert.rejects(
    () => refs.readAssetReference(OTHER, TOKEN),
    (error) => error.status === 400 && error.code === 'ASSET_REF_MISSING',
  )
})

test('选择器只列 ready/partial 且有图的槽位：draft 与没图的套不出现', async () => {
  const options = await refs.listAssetRefOptions(OWNER)
  const ids = options.map((item) => item.id)
  // 产品 ready 两张（hero/scene）+ 数字人 partial 一张（front）；draft 与没图的套不出现
  assert.deepEqual(ids.sort(), [TOKEN, ASSET_ID + ':scene', 'asst_mtest02_beef34:front'].sort())
  const hero = options.find((item) => item.id === TOKEN)
  assert.equal(hero.full, '产品「美式咖啡机」· 白底主图')
  assert.equal(hero.url, '/api/assets/' + ASSET_ID + '/files/hero')
  assert.equal(hero.width, 1)
  assert.equal(hero.height, 1)
  assert.ok(!ids.includes('asst_mtest03_cafe56:hero'), 'draft 套还没出图，不能进选择器')
  assert.ok(!ids.includes('asst_mtest04_d00d78:hero'), '没有 refs 的套不能进选择器')
})

test('资产被删 / 图文件被删：读不到就抛 ASSET_REF_MISSING（调用方据此在扣费前失败）', async () => {
  await assert.rejects(
    () => refs.readAssetReference(OWNER, 'asst_mtest99_dead00:hero'),
    (error) => error.status === 400 && error.code === 'ASSET_REF_MISSING',
  )
  await assert.rejects(
    () => refs.readAssetReference(OWNER, ASSET_ID + ':nope'),
    (error) => error.status === 400 && error.code === 'ASSET_REF_MISSING',
  )
  fs.rmSync(avatarRoot, { recursive: true, force: true })
  await assert.rejects(
    () => refs.readAssetReference(OWNER, 'asst_mtest02_beef34:front'),
    (error) => error.status === 400 && error.code === 'ASSET_REF_MISSING',
  )
})

test('工作流出图节点：资产读不到时不扣费、节点直接失败，不静默退回纯文生图', async () => {
  const [flows, credits, auth] = await Promise.all([
    import('../server/flows.mjs'),
    import('../server/credits.mjs'),
    import('../server/auth.mjs'),
  ])
  // 扣费只认真实账号：建一个临时用户，余额从 100 起，才有「一分没少」可断言
  const email = 'assetref' + String.fromCharCode(64) + 'asset.test'
  const user = auth.createUser({ email, password: 'Passw0rd!demo', name: '资产引用', kind: 'user' })
  credits.grant(user.id, 100, { note: 'asset-ref test' })
  const before = credits.balanceOf(user.id)
  const flow = {
    id: 'flow_assetref_missing',
    name: '资产引用缺失',
    ownerId: user.id,
    nodes: [
      {
        id: 'image-1',
        type: 'image',
        position: { x: 0, y: 0 },
        data: {
          kind: 'image',
          title: '出图',
          description: '',
          config: { model: '', ratio: '9:16', prompt: '一只橘猫坐在木桌上', assetRef: 'asst_mtest99_dead00:hero' },
        },
      },
    ],
    edges: [],
  }
  const run = await flows.runFlow(flow)
  assert.equal(run.status, 'error')
  const node = run.nodes.find((item) => item.id === 'image-1')
  assert.equal(node.status, 'error')
  assert.match(node.error, /这套资产图不在了/, '错误文案用 ASSET_REF_MISSING 那条，不换成泛泛的失败')
  assert.equal(credits.balanceOf(user.id), before, '读不到资产时一分钱都不能扣')
})

test('作品上的参考资产：写入归一、空串清掉、列表与详情都回它', async () => {
  const projects = await import('../server/projects.mjs')
  const user = { id: OWNER, name: '资产用户' }
  const created = await projects.createProject({ title: '带资产的商品图' }, user)
  assert.equal(created.assetRef, '', '默认没有参考资产，行为与以前一致')
  const saved = await projects.updateProject(created.id, { assetRef: TOKEN }, user)
  assert.equal(saved.assetRef, TOKEN)
  const detail = await projects.getProject(created.id, user)
  assert.equal(detail.assetRef, TOKEN)
  const listed = await projects.listProjects(user)
  assert.equal(listed.find((item) => item.id === created.id).assetRef, TOKEN)
  const cleared = await projects.updateProject(created.id, { assetRef: '' }, user)
  assert.equal(cleared.assetRef, '', '传空串就是清掉')
  const invalid = await projects.updateProject(created.id, { assetRef: 'not-a-ref' }, user)
  assert.equal(invalid.assetRef, '', '非法引用按「没有」处理，不把作品写成永远读不到的状态')
})

// —— 排版层面的契约：接线必须真的存在，不能只剩一层解析函数 ——

const readSource = (relative) => fs.readFileSync(new URL('../' + relative, import.meta.url), 'utf8')

test('快捷创作 / 作品逐镜出图：assets 里混着资产引用时走 readAssetReference', () => {
  const media = readSource('server/routes/media-gen.mjs')
  assert.match(media, /import \{[^}]*readAssetReference[^}]*\} from '\.\.\/asset-ref\.mjs'/)
  assert.match(media, /readAssetReference\(user\.id, token\)/)
  assert.match(media, /'asset:' \+ ref\.token/, '任务元数据里要能分出「这是资产图」')
  assert.match(media, /MIME_EXT\[ref\.mime\]/, '扩展名按服务端认出来的 mime 定')
})

test('工作流：出图 / 出视频都在扣费之前读资产，读不到不许静默退回纯文生图', () => {
  const flows = readSource('server/flows.mjs')
  const imageBody = flows.slice(flows.indexOf('async function runImage'), flows.indexOf('async function runVideo'))
  const videoBody = flows.slice(flows.indexOf('async function runVideo'), flows.indexOf('async function runKb'))
  for (const [name, body, call] of [['出图', imageBody, 'runImageGeneration'], ['出视频', videoBody, 'runVideoGeneration']]) {
    assert.match(body, /readAssetReference\(ctx\.ownerId, cfg\.assetRef\)/, name + '要读参考资产')
    const callAt = body.indexOf('return ' + call)
    assert.ok(callAt > 0, name + '要调用 ' + call)
    assert.ok(body.indexOf('readAssetReference') < callAt, name + '必须先读资产再进扣费那次调用')
  }
  assert.match(flows, /assetRef: normalizeAssetRef\(source\.assetRef\)/, '非法引用存空串（保存不拒绝，运行不静默兜底）')
})

test('出视频带参考资产：payload 里是 referenceAssets + image2video', () => {
  const video = readSource('server/flow-video.mjs')
  assert.match(video, /referenceAssets: \[\{/)
  assert.match(video, /mode: 'image2video'/)
  assert.match(video, /reference\.label/, '节点输出文本要写清用了哪套资产')
  const image = readSource('server/flow-image.mjs')
  assert.match(image, /edit: reference \? \{ image: reference\.buffer, mime: reference\.mime, filename: reference\.filename \}/)
  assert.match(image, /参考资产：' \+ reference\.label/)
})
