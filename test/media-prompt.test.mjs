// r293：只说了「帮我出个视频」时，用文本模型补提示词。call 是注入的假函数，不真调上游。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-media-prompt-'))
process.env.DATA_DIR = dir

const { enhanceMediaPrompt, readPrompt } = await import('../server/media-prompt.mjs')

test('readPrompt：JSON、纯文本、「提示词：」前缀都认', () => {
  assert.equal(readPrompt('{"prompt":"雨夜的杭州街头"}'), '雨夜的杭州街头')
  assert.equal(readPrompt('好的：\n{"prompt":"雨夜的杭州街头"}'), '雨夜的杭州街头')
  assert.equal(readPrompt('雨夜的杭州街头'), '雨夜的杭州街头')
  assert.equal(readPrompt('提示词：雨夜的杭州街头'), '雨夜的杭州街头')
  assert.equal(readPrompt('「雨夜的杭州街头」'), '雨夜的杭州街头')
  assert.equal(readPrompt(''), '')
})

test('改写成功：把模型给的提示词交出来，参数不写进提示词', async () => {
  let seen = null
  const call = async (messages, options) => {
    seen = { messages, options }
    return { text: '{"prompt":"雨夜杭州街头，湿漉漉的青石板反光，霓虹在积水里拉出长条，镜头缓慢前推"}' }
  }
  const out = await enhanceMediaPrompt({ kind: 'video', text: '帮我出个视频', call })
  assert.equal(out.note, '')
  assert.match(out.prompt, /雨夜杭州街头/)
  assert.equal(seen.options.json, true, '要结构化输出，别让模型自由发挥')
  const asked = seen.messages.map((item) => item.content).join('\n')
  assert.match(asked, /帮我出个视频/, '用户原话要带给模型')
  assert.match(asked, /不要写比例、秒数、清晰度/, '参数由系统定，提示词里不许重复')
})

test('改写失败或写得太短：回空并给一句能读懂的话，绝不交空提示词去扣积分', async () => {
  const broken = await enhanceMediaPrompt({ kind: 'video', text: '帮我出个视频', call: async () => { throw new Error('上游 502') } })
  assert.equal(broken.prompt, '')
  assert.match(broken.note, /补一句画面/)

  const empty = await enhanceMediaPrompt({ kind: 'image', text: '帮我做张图', call: async () => ({ text: '好' }) })
  assert.equal(empty.prompt, '')
  assert.match(empty.note, /补一句画面/)
})

test('上下文会带上最近几句，方便「再来一条刚才那种」', async () => {
  let asked = ''
  const call = async (messages) => {
    asked = messages.map((item) => item.content).join('\n')
    return { text: '{"prompt":"毛衣折叠收纳袋在木桌上被折叠，特写，暖光"}' }
  }
  const out = await enhanceMediaPrompt({
    kind: 'video',
    text: '帮我出个视频',
    context: ['我要卖毛衣收纳袋', '这个是秋冬款'],
    call,
  })
  assert.match(asked, /我要卖毛衣收纳袋/)
  assert.match(asked, /秋冬款/)
  assert.match(out.prompt, /毛衣/)
})
