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
