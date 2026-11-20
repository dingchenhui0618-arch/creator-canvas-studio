// 界面文案的自查（r272）：改名留下的重复词与自指句。
//
// 背景：v0.9.163 把「画布」这个名字拆成「工作流」与「无限画布」两件东西，
// 当时用批量替换改名，于是「画布工作流」「画布上另存的工作流」这类说法变成了
// 「工作流工作流」「工作流上另存的工作流」——前者是重复词，后者是自指病句。
// 这些字都落在用户看得见的地方（公开分享页、导出的 Markdown、读屏标签），
// 一条一条对不划算，改成一条静态检查：同类改名不必再靠人眼扫一遍。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCAN_DIRS = ['src', 'server']
const EXT = /[.](ts|tsx|mjs|css|html)$/

// 只禁「同一段字原样重复两遍」这类改名事故；「一栏一栏 / 一条一条 / 一行一行」
// 是正常的中文叠用，和白名单无关——它们本来就不该被这条规则拦。
const BANNED = ['工作流工作流', '画布画布', '运行运行', '模板模板', '作品作品', '评审评审']

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (EXT.test(entry.name)) out.push(full)
  }
  return out
}

const files = SCAN_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)))

test('源码里不许留下改名造成的重复词', () => {
  const hits = []
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    for (const word of BANNED) {
      let index = text.indexOf(word)
      while (index >= 0) {
        const line = text.slice(0, index).split('\n').length
        hits.push(path.relative(ROOT, file) + ':' + line + ' 「' + word + '」')
        index = text.indexOf(word, index + 1)
      }
    }
  }
  assert.deepEqual(hits, [], '这些地方还留着重复词：\n' + hits.join('\n'))
})

test('「另存」这件事不许再写成一件事套一件事（工作流上另存的工作流）', () => {
  const hits = []
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    if (text.includes('工作流上另存的工作流')) hits.push(path.relative(ROOT, file))
  }
  assert.deepEqual(hits, [], '改成「从一条工作流另存下来的模板」')
})

test('扫到的文件不是空的（别因为目录名改了而静静放过）', () => {
  assert.ok(files.length > 300, '只扫到 ' + files.length + ' 个文件，路径可能变了')
})
