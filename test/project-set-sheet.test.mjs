// 现场页：一张只带脚本与分镜的纸。
// 这里验的是「纸上写了什么」——口径对不对、帧图缺了怎么写、超过上限怎么裁、别人的台词会不会被当标签。
import assert from 'node:assert/strict'
import test from 'node:test'
import { packageNote, setSheetHtml, setSheetModel } from '../server/project-set-sheet.mjs'

const project = { id: 'prj_sheet', title: '咖啡 3 分钟', version: 2 }

const template = {
  id: 'tpl_sheet',
  title: '咖啡 3 分钟',
  kind: 'replica',
  platformLabel: '抖音',
  hookType: '提问式',
  durationSec: 18,
  storyboard: [
    { shotNo: 1, startSec: 0, endSec: 3, visual: '近景手部', camera: '俯拍', caption: '三分钟', frameUrl: '/media/frames/tpl_sheet/frame-01.jpg' },
    { shotNo: 2, startSec: 3, endSec: 8, visual: '中景拉花', camera: '侧拍', caption: '', frameUrl: '/media/frames/tpl_sheet/frame-02.jpg' },
    { shotNo: 3, startSec: 8, endSec: 12, visual: '成品出镜', camera: '正面', caption: '', audio: '轻音乐', frameUrl: '' },
  ],
}

const script = {
  hook: '三分钟做一杯手冲',
  structure: [
    { beat: '开场', startSec: 0, endSec: 3, voiceover: '三分钟做一杯手冲咖啡', onScreen: '00:03', purpose: '抓住', expectedSec: 4.8, fit: 'tight' },
    { beat: '闷蒸', startSec: 3, endSec: 8, voiceover: '先闷蒸三十秒', onScreen: '', purpose: '教学', expectedSec: 3.2, fit: 'ok' },
  ],
  timing: { estimatedSec: 25.5, durationSec: 18, pace: 'normal', rate: 4.2 },
}

test('模型：段落与镜头按模板/脚本拆开，帧图只认自己模板那一条', () => {
  const model = setSheetModel({ project, script, template })
  assert.equal(model.title, '咖啡 3 分钟')
  assert.equal(model.version, 2)
  assert.equal(model.hook, '三分钟做一杯手冲')
  assert.equal(model.beats.length, 2)
  assert.equal(model.beats[0].span, '0–3 秒')
  assert.equal(model.beats[0].read, '4.8')
  assert.equal(model.beats[0].tight, true)
  assert.equal(model.beats[1].tight, false)
  assert.equal(model.shotTotal, 3)
  assert.equal(model.withFrame, 2, '第三镜没有帧图，不能算进去')
  assert.equal(model.shots[0].file, 'shot-01.jpg')
  assert.equal(model.shots[2].frameUrl, '')
})

test('现场页：钩子、脚本表、偏多标记与镜头卡片都在纸上一张里', () => {
  const html = setSheetHtml({ project, script, template, projectId: project.id, generatedAt: '2026-11-12T06:30:00.000Z' })
  assert.match(html, /SET SHEET \/ A4/)
  assert.match(html, /开头钩子：<strong>三分钟做一杯手冲<\/strong>（提问式）/)
  assert.match(html, /三分钟做一杯手冲咖啡/, '口播必须印出来')
  assert.match(html, /4.8 秒 · 偏多/, '偏多的段落要标出来')
  assert.match(html, /镜头 01 · 0–3 秒/)
  assert.match(html, /镜头 03 · 8–12 秒/)
  assert.match(html, /src="\/media\/frames\/tpl_sheet\/frame-01.jpg"/, '线上帧图走登录态地址')
  assert.match(html, /没存帧图/, '没有帧图的那一镜照实写')
  assert.match(html, /2026-11-12 14:30/, '纸脚按东八区写导出时间')
  // 现场页只印脚本与分镜：交付稿里的评审、运行、逐版对照不该出现
  assert.doesNotMatch(html, /版本对照/)
  assert.doesNotMatch(html, /运行记录/)
})

test('交付包里的现场页：帧图改成 frames/ 相对路径，缺图的那一镜仍然写没存帧图', () => {
  const html = setSheetHtml({
    project,
    script,
    template,
    frameBase: 'frames/',
    availableFrames: new Set(['shot-01.jpg', 'shot-02.jpg']),
    offline: true,
    generatedAt: '2026-11-12T06:30:00.000Z',
  })
  assert.match(html, /src="frames\/shot-01.jpg"/)
  assert.match(html, /src="frames\/shot-02.jpg"/)
  assert.match(html, /没存帧图/)
  // 离线打开时不该有「返回作品」这种本机打不开的链接，品牌改用文字
  assert.doesNotMatch(html, /返回作品/)
  assert.match(html, /sheet-textbrand/)
})

test('交付包里声明了哪些帧图之后，包里没打进去的就不再引用它', () => {
  const html = setSheetHtml({
    project,
    script,
    template,
    frameBase: 'frames/',
    availableFrames: new Set(['shot-01.jpg']),
  })
  assert.match(html, /src="frames\/shot-01.jpg"/)
  assert.doesNotMatch(html, /frames\/shot-02.jpg/, '没打进去的帧图不能留一个打不开的地址')
  assert.match(html, /没存帧图/)
})

test('空的状态照实写：没脚本 / 没分镜都不编', () => {
  const noScript = setSheetHtml({ project, template: { ...template, structure: [] }, script: null })
  assert.match(noScript, /还没写脚本/)
  const noShots = setSheetHtml({ project, script, template: { ...template, storyboard: [] } })
  assert.match(noShots, /模板没有分镜表/)
})

test('台词里的尖括号不会变成标签：纸是服务端拼的，别人的台词不能当 HTML', () => {
  const html = setSheetHtml({
    project: { ...project, title: '<script>alert(1)</script>' },
    script: { hook: '<img onerror=1>', structure: [{ beat: '<b>开场</b>', voiceover: '<script>x</script>', onScreen: '' }] },
    template: { ...template, storyboard: [] },
  })
  assert.doesNotMatch(html, /<script>alert/)
  assert.doesNotMatch(html, /<img onerror/)
  assert.match(html, /&lt;script&gt;/)
})

test('超上限就只印前 N 条，并在纸上说还剩几条', () => {
  const many = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四']
  const longScript = { structure: many.map((name, index) => ({ beat: name, voiceover: name, startSec: index, endSec: index + 1 })) }
  const model = setSheetModel({ project, script: longScript, template: { ...template, storyboard: [] } })
  assert.equal(model.beats.length, 12)
  assert.equal(model.beatsHidden, 2)
  const html = setSheetHtml({ project, script: longScript, template: { ...template, storyboard: [] } })
  assert.match(html, /只印前 12 段/)
})

test('交付包的说明：文件对应关系与帧图张数，没帧图就说明白', () => {
  const model = setSheetModel({ project, script, template })
  const note = packageNote({ model, frameCount: 2, generatedAt: '2026-11-12T06:30:00.000Z' })
  assert.match(note, /交付稿\.md/)
  assert.match(note, /现场页\.html/)
  assert.match(note, /原片帧图 2 张/)
  assert.match(note, /shot-01\.jpg/)
  const empty = packageNote({ model, frameCount: 0 })
  assert.match(empty, /没有帧图可打/)
})
