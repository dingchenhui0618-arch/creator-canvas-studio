import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 模板详情里的「改编自谁」（r254）。
// 模板上只存了来源那条的 id，以前抽屉直接把 `tpl_xxxxxxxx` 摆在用户面前——
// 一串原始 id 谁也认不出是哪条，也点不过去。这里盯四件事：
//   1. 来源在「当前账号看得见的那份列表」里，就把它的标题给出去；
//   2. 没有 adaptedFrom（不是改编来的）回空串，界面不会写「改编自另一条模板」；
//   3. 来源被删 / 不在列表里（别人的、没授权）回空串——不拿 id 冒充标题，也不把别人的标题漏出去；
//   4. 标题本身是空的，等于没查到；列表没给也不炸。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-template-lineage-'))
process.env.DATA_DIR = dir
fs.mkdirSync(path.join(dir, 'frames'), { recursive: true })

const { adaptedFromTitle } = await import('../server/templates.mjs')

const list = [
  { id: 'tpl_a', title: '毛衣折叠收纳法（原片）' },
  { id: 'tpl_blank', title: '' },
]

test('来源看得见：给标题，不给 id', () => {
  assert.equal(adaptedFromTitle({ adaptedFrom: 'tpl_a' }, list), '毛衣折叠收纳法（原片）')
})

test('不是改编来的：没有 adaptedFrom 就回空串', () => {
  assert.equal(adaptedFromTitle({}, list), '')
  assert.equal(adaptedFromTitle({ adaptedFrom: '' }, list), '')
  assert.equal(adaptedFromTitle(null, list), '')
})

test('来源被删或不在当前账号下：回空串，不拿 id 当标题', () => {
  assert.equal(adaptedFromTitle({ adaptedFrom: 'tpl_gone' }, list), '')
})

test('来源那条标题是空的：等于没查到', () => {
  assert.equal(adaptedFromTitle({ adaptedFrom: 'tpl_blank' }, list), '')
})

test('列表没给（调用方漏传）也不炸', () => {
  assert.equal(adaptedFromTitle({ adaptedFrom: 'tpl_a' }), '')
})
