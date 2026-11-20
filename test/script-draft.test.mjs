import test from 'node:test'
import assert from 'node:assert/strict'

// 画布草稿与作品脚本同源：作品页改的脚本要真的进到画布的复刻提示词里，
// 但用户手改过的提示词不能被覆盖——只认我们自己生成的那一版。
const draft = await import('../server/script-draft.mjs')

const template = {
  title: '咖啡 3 分钟',
  contentType: '美食教程',
  hook: '模板的钩子',
  durationSec: 18,
  structure: [
    { beat: '开场', startSec: 0, endSec: 3, voiceover: '模板第一句', expectedSec: 1.2 },
    { beat: '做法', startSec: 3, endSec: 8, voiceover: '模板第二句', expectedSec: 2.4 },
  ],
  analysis: { reusableRules: ['先给结果'] },
  timing: { pace: '快' },
}

const script = {
  hook: '我改过的钩子',
  structure: [
    { beat: '开场', startSec: 0, endSec: 3, voiceover: '我改过的第一句', expectedSec: 1.6 },
    { beat: '收尾', startSec: 3, endSec: 8, voiceover: '新的收尾', expectedSec: 2.4 },
  ],
}

test('提示词用作品脚本：口播、钩子、段落名都是新的，不再出现模板旧词', () => {
  const prompt = draft.buildReplicatePrompt({ template, script })
  assert.ok(prompt.startsWith(draft.AUTO_PROMPT_PREFIX), '开头是固定句，改脚本时靠它认出自动生成的节点')
  assert.match(prompt, /我改过的钩子/)
  assert.match(prompt, /我改过的第一句/)
  assert.match(prompt, /新的收尾/)
  assert.ok(!prompt.includes('模板第一句'))
  assert.match(prompt, /可复用规则：先给结果/)
  assert.match(prompt, /1.6s/, '提示词里带每段要念几秒，复刻才不会把镜头压爆')
  assert.match(prompt, /开场 → 收尾/, '结构按段落名串起来')
})

test('没有作品脚本时回退到模板：老作品开画布行为不变', () => {
  const prompt = draft.buildReplicatePrompt({ template, script: null })
  assert.match(prompt, /模板第一句/)
  assert.match(prompt, /模板的钩子/)

  const built = draft.buildReplicateDraft({ template, script: null, name: '咖啡 3 分钟' })
  assert.equal(built.name, '咖啡 3 分钟')
  assert.equal(built.nodes.length, 2)
  assert.equal(built.nodes[0].data.config.text, '模板的钩子', '输入节点带钩子')
  assert.equal(built.nodes[1].data.kind, 'llm')
  assert.equal(built.edges.length, 1)
})

test('模板已删除也能用作品脚本开画布：脚本自己就是来源', () => {
  const prompt = draft.buildReplicatePrompt({ template: null, script })
  assert.match(prompt, /我改过的第一句/)
  const built = draft.buildReplicateDraft({ template: null, script, name: '我的作品' })
  assert.equal(built.nodes[0].data.config.text, '我改过的钩子')
  const patched = draft.patchCanvasScript(built.nodes, { template: null, script, prevHook: '旧钩子' })
  assert.equal(patched.promptUpdated, true)
})

test('改脚本写回画布：只认自动生成的复刻节点，手改过的不覆盖', () => {
  const built = draft.buildReplicateDraft({ template, script: { hook: '旧钩子', structure: template.structure } })
  const patched = draft.patchCanvasScript(built.nodes, { template, script, prevHook: '旧钩子' })
  assert.equal(patched.changed, true)
  assert.equal(patched.promptUpdated, true, '提示词确实换成了新脚本')
  const promptNode = patched.nodes.find((node) => node.id === 'n_llm')
  assert.match(promptNode.data.config.systemPrompt, /我改过的第一句/)
  const inputNode = patched.nodes.find((node) => node.id === 'n_input')
  assert.equal(inputNode.data.config.text, '我改过的钩子', '输入节点里的旧钩子跟着换')

  // 两处都手改过：一个字段都不动
  const handEdited = built.nodes.map((node) => {
    if (node.id === 'n_llm') return { ...node, data: { ...node.data, config: { ...node.data.config, systemPrompt: '我自己的提示词，别动' } } }
    return { ...node, data: { ...node.data, config: { ...node.data.config, text: '我自己写的素材' } } }
  })
  const kept = draft.patchCanvasScript(handEdited, { template, script, prevHook: '旧钩子' })
  assert.equal(kept.changed, false, '手改过的提示词与素材都整块跳过')
  assert.equal(kept.promptUpdated, false, '提示词没换，不能说画布用的是新脚本')
  assert.equal(kept.nodes.find((node) => node.id === 'n_llm').data.config.systemPrompt, '我自己的提示词，别动')
  assert.equal(kept.nodes.find((node) => node.id === 'n_input').data.config.text, '我自己写的素材')

  // 只改过输入素材：提示词照常换新，素材保留
  const customInput = built.nodes.map((node) =>
    node.id === 'n_input' ? { ...node, data: { ...node.data, config: { ...node.data.config, text: '我自己写的素材' } } } : node,
  )
  const keptInput = draft.patchCanvasScript(customInput, { template, script, prevHook: '旧钩子' })
  assert.equal(keptInput.changed, true, '提示词还是要换')
  assert.equal(keptInput.promptUpdated, true)
  assert.equal(keptInput.nodes.find((node) => node.id === 'n_input').data.config.text, '我自己写的素材')
})

// r277：作品页「开工作流」不再只生成一段复刻文本——分镜里有几镜就建几个出图节点，
// 跑一次工作流得到的是「复刻脚本 + 每一镜的一张画面」。这一组盯四件事：
//   1) 节点数、标题、比例、连线都对；
//   2) 出图提示词与作品页「出这一镜」是同一条（拼在服务端，必须与前端逐字一致）；
//   3) 节点本身不花钱：模型留空跟平台统一路由，价格只在运行时按张扣；
//   4) 分镜太多时有上限，且在描述里如实说「还有几镜没建」。
const shotPromptDomain = await import('../src/domain/shot-prompt.ts')

const storyboard = [
  { shotNo: 1, startSec: 0, endSec: 3, visual: '咖啡机特写，蒸汽升起', camera: '近景固定' },
  { shotNo: 2, startSec: 3, endSec: 8, visual: '咖啡倒进玻璃杯', camera: '中景跟手' },
  { shotNo: 3, startSec: 8, endSec: 12, visual: '', camera: '' },
]

const ownScript = {
  hook: '我改过的钩子',
  structure: [
    { beat: '开场', startSec: 0, endSec: 3, voiceover: '我改过的第一句', expectedSec: 1.6 },
    { beat: '收尾', startSec: 3, endSec: 8, voiceover: '新的收尾', expectedSec: 2.4 },
  ],
  source: 'project',
}

test('分镜有几镜就建几个出图节点：接在复刻脚本下游、比例跟平台、模型留空跟统一路由', () => {
  const built = draft.buildReplicateDraft({ template: { ...template, platform: 'douyin', storyboard }, script: ownScript, name: '咖啡 3 分钟' })
  const images = built.nodes.filter((node) => node.type === 'image')
  assert.equal(images.length, 3)
  assert.equal(built.nodes.length, 5, '输入 + 复刻 + 3 镜出图')
  assert.deepEqual(images.map((node) => node.id), ['n_shot_01', 'n_shot_02', 'n_shot_03'])
  assert.equal(images[0].data.title, '第 01 镜 · 出图')
  assert.equal(images[0].data.kind, 'image')
  assert.equal(images[0].data.config.ratio, '9:16', '竖屏平台按 9:16')
  assert.equal(images[0].data.config.model, '', '模型留空 = 跟随平台统一路由，不把模型 id 写死')
  assert.match(images[0].data.description, /近景固定 · 咖啡机特写/)
  // 每镜都从复刻脚本接出去：复刻失败时这些图跟着跳过，不会拿半截结果去画
  const fanout = built.edges.filter((edge) => edge.source === 'n_llm').map((edge) => edge.target)
  assert.deepEqual(fanout, ['n_shot_01', 'n_shot_02', 'n_shot_03'])
  assert.equal(new Set(built.edges.map((edge) => edge.id)).size, built.edges.length, '连线 id 不重复')
  assert.equal(new Set(built.nodes.map((node) => node.id)).size, built.nodes.length, '节点 id 不重复')
  assert.match(built.description, /3 个出图节点/)
})

test('出图提示词与作品页「出这一镜」是同一条：服务端拼的，逐字比', () => {
  const built = draft.buildReplicateDraft({ template: { ...template, platform: 'douyin', storyboard }, script: ownScript })
  const images = built.nodes.filter((node) => node.type === 'image')
  storyboard.forEach((shot, index) => {
    const beat = shotPromptDomain.beatForShot(shot, ownScript.structure)
    const expected = shotPromptDomain.shotPrompt(shot, beat, { platform: 'douyin', scriptSource: 'own' })
    assert.equal(images[index].data.config.prompt, expected, '第 ' + shot.shotNo + ' 镜提示词一致')
  })
  // 口播是作品自己的那份：句子要说「这条作品自己的脚本」，不能冒充原片口播
  assert.match(images[0].data.config.prompt, /画面按这条作品自己的脚本：我改过的第一句/)
  assert.doesNotMatch(images[0].data.config.prompt, /第 ?0?1 ?镜/, '提示词正文里不出现镜头号')
})

test('还在跟模板的脚本：提示词写「原片这一段口播」；横屏平台按 16:9', () => {
  const tmpl = { ...template, platform: 'bilibili', storyboard }
  const built = draft.buildReplicateDraft({ template: tmpl, script: { ...ownScript, source: 'template' } })
  const images = built.nodes.filter((node) => node.type === 'image')
  assert.equal(images[0].data.config.ratio, '16:9')
  assert.match(images[0].data.config.prompt, /横屏 16:9/)
  assert.match(images[0].data.config.prompt, /画面按原片这一段口播：我改过的第一句/)
  const noSource = draft.buildReplicateDraft({ template: tmpl, script: { hook: '钩子', structure: ownScript.structure } })
  assert.match(noSource.nodes.find((node) => node.type === 'image').data.config.prompt, /画面按这段口播：/)
})

test('分镜超过上限：只建 12 个出图节点，描述里如实说还有几镜没建', () => {
  const many = Array.from({ length: 20 }, (_, index) => ({ shotNo: index + 1, startSec: index, endSec: index + 1, visual: '第 ' + (index + 1) + ' 个画面' }))
  const built = draft.buildReplicateDraft({ template: { ...template, storyboard: many }, script: ownScript })
  const images = built.nodes.filter((node) => node.type === 'image')
  assert.equal(images.length, draft.MAX_SHOT_NODES)
  assert.equal(images.length, 12)
  assert.match(built.description, /12 个出图节点（还有 8 镜没建/)
  // 12 个卡片不能叠在一起：位置必须两两不同
  assert.equal(new Set(images.map((node) => node.position.x + ',' + node.position.y)).size, 12)
})

test('没有分镜就还是两个节点：老作品开工作流行为不变', () => {
  const built = draft.buildReplicateDraft({ template, script: ownScript })
  assert.equal(built.nodes.length, 2)
  assert.equal(built.edges.length, 1)
  assert.doesNotMatch(built.description, /出图节点/)
})
test('作品页「开工作流」真的把分镜交给草稿，界面按服务端节点数说画几张', async () => {
  const fs = await import('node:fs')
  const route = fs.readFileSync(new URL('../server/routes/projects.mjs', import.meta.url), 'utf8')
  assert.match(route, /buildReplicateDraft\(\{ template: template \|\| \{\}, script, name: project\.title \}\)/, '开工作流这条路把模板（含分镜）交给草稿')
  const page = fs.readFileSync(new URL('../src/pages/ProjectPage.tsx', import.meta.url), 'utf8')
  // 说「会画几张」要用服务端建出来的节点数，不是自己按镜数乘：分镜超过上限时服务端只建 12 个
  assert.match(page, /Math\.max\(0, \(result\.flow\.nodes \|\| 0\) - 2\)/)
  assert.match(page, /跑一次会画 ' \+ shotNodes \+ ' 张，每张 ' \+ eachPrice \+ ' 积分/)
  assert.match(page, /节点本身不扣积分，跑一次每张画扣 /)
})
