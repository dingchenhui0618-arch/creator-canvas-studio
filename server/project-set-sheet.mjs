// 现场页：一张带原片帧图的 A4，只回答两件事——「念什么」和「拍什么」。
//
// 交付稿回答的是「这一版做完了没有」（评审、运行、逐版对照），编导带到现场的是另一张纸：
// 脚本要能一眼念，分镜要能一眼对上原片机位，帧图要能离线看。
// 所以这张纸只带脚本 + 分镜，别的不印；口径与交付稿同源（都读 scriptView / 模板分镜）。
//
// 三种用法，内容同一份：
//  1. 线上：/print/projects/<id>/deliverable?only=script，帧图走登录态的 /media/frames。
//  2. 交付包里：现场页.html + frames/shot-01.jpg…，解压后双击就能看，不用登录、不用联网。
//  3. 打印：浏览器自己的 PDF 引擎，纸张 A4，镜头卡片不跨页。
//
// 边界：没写脚本 / 模板没分镜 / 帧图没存，都照实写，不拿别的数据顶。
import { escapeHtml, paperShell, printToolbar } from './project-deliverable-html.mjs'

export const SET_SHEET_LIMITS = { beats: 12, shots: 24 }

const PACE_LABEL = { fast: '快', slow: '慢', normal: '中' }

const flat = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

const num = (value) => {
  const amount = Number(value)
  return Number.isFinite(amount) && amount > 0 ? amount : 0
}

const sec = (value) => {
  const amount = num(value)
  return amount ? String(Math.round(amount * 10) / 10) : ''
}

const round1 = (value) => String(Math.round(num(value) * 10) / 10)

const pad2 = (value) => String(value).padStart(2, '0')

/**
 * 「只印这几镜」：'2-4,7' / '2、4，7' / '2 至 4' → Set([2,3,4,7])；空或不认 → null（印全部）。
 * 纸不是表单：写错的写法不报错、不猜，直接退回全部——现场没人愿意先跟输入框斗智斗勇。
 * 上限两种都封：镜号本身（shotCount）与纸上最多印几镜（SET_SHEET_LIMITS.shots）。
 */
export function parseShotRange(raw, shotCount = 0) {
  const text = String(raw ?? '').trim()
  const total = Math.min(Math.max(0, Math.floor(Number(shotCount) || 0)), SET_SHEET_LIMITS.shots)
  if (!text || !total) return null
  const picked = new Set()
  for (const token of text.split(/[,，、;；\s]+/)) {
    if (!token) continue
    const range = token.match(/^(\d+)\s*[-–~至]\s*(\d+)$/)
    if (range) {
      const from = Math.min(Number(range[1]), Number(range[2]))
      const to = Math.max(Number(range[1]), Number(range[2]))
      for (let n = from; n <= to; n += 1) if (n >= 1 && n <= total) picked.add(n)
      continue
    }
    const single = token.match(/^(\d+)$/)
    if (single) {
      const n = Number(single[1])
      if (n >= 1 && n <= total) picked.add(n)
    }
  }
  return picked.size ? picked : null
}

/** 反过来：Set([2,3,4,7]) → '2–4、7'。纸上写给人的，不用 JSON。 */
export function shotRangeLabel(numbers) {
  const list = [...new Set([...numbers].map(Number).filter(Number.isFinite))].sort((a, b) => a - b)
  const parts = []
  let start = list.length ? list[0] : null
  let prev = start
  for (const n of list.slice(1)) {
    if (n === prev + 1) {
      prev = n
      continue
    }
    parts.push(start === prev ? String(start) : start + '–' + prev)
    start = n
    prev = n
  }
  if (start !== null) parts.push(start === prev ? String(start) : start + '–' + prev)
  return parts.join('、')
}

function normalizeShotSet(value) {
  if (value instanceof Set) {
    const list = [...value].map(Number).filter(Number.isFinite)
    return list.length ? new Set(list) : null
  }
  if (Array.isArray(value)) {
    const list = value.map(Number).filter(Number.isFinite)
    return list.length ? new Set(list) : null
  }
  return null
}

// 帧图地址只认这一种形状：/media/frames/<模板 id>/<文件名>。
// 模板 id 必须和手上的模板对得上——不拿外部拼出来的路径去读盘。
function frameOf(shot, template) {
  const url = String(shot?.frameUrl || '')
  const matched = url.match(/^\/media\/frames\/([\w-]+)\/([\w.-]+)$/)
  if (!matched || !template?.id || matched[1] !== template.id) return { url: '', file: '' }
  return { url, file: matched[2] }
}

function span(startSec, endSec) {
  const from = Number(startSec)
  const to = Number(endSec)
  if (!Number.isFinite(from) || !Number.isFinite(to) || (from <= 0 && to <= 0)) return '时间待定'
  return Math.round(from) + '–' + Math.round(to) + ' 秒'
}

/**
 * 现场页的内容模型：纯数据，测试对着它断言，视图只负责排。
 * 段落与镜头分别封顶（12 / 24）：超过就只印前 N 条并在纸上说还剩几条——
 * 一张印出三十几镜的纸在现场反而没人翻。
 */
export function setSheetModel({ project = {}, script = null, template = null, onlyShots = null } = {}) {
  const structure = Array.isArray(script?.structure) ? script.structure : []
  const allShots = Array.isArray(template?.storyboard) ? template.storyboard : []
  // 只印某几镜：所有卡片都排进 DOM，只是没选中的带 is-off（纸上与屏幕上都隐藏）。
  // 这样现场改选区不用重新请求，交付包里双击打开（file://）也能改；
  // 服务端按 URL 上的 ?shots= 先把该隐藏的隐藏好，关掉脚本也不影响这张纸。
  const picked = normalizeShotSet(onlyShots)
  const beats = structure.slice(0, SET_SHEET_LIMITS.beats).map((beat, index) => ({
    no: index + 1,
    span: span(beat.startSec, beat.endSec),
    beat: flat(beat.beat) || '第 ' + (index + 1) + ' 段',
    voiceover: flat(beat.voiceover),
    onScreen: flat(beat.onScreen),
    read: sec(beat.expectedSec),
    tight: beat.fit === 'tight',
  }))
  const cappedShots = allShots.slice(0, SET_SHEET_LIMITS.shots)
  const shots = cappedShots.map((shot, index) => {
    const frame = frameOf(shot, template)
    return {
      no: Number(shot.shotNo) || index + 1,
      span: span(shot.startSec, shot.endSec),
      visual: flat(shot.visual),
      camera: flat(shot.camera),
      caption: flat(shot.caption),
      audio: flat(shot.audio),
      frameUrl: frame.url,
      frameFile: frame.file,
      file: 'shot-' + pad2(Number(shot.shotNo) || index + 1) + '.jpg',
    }
  }).map((shot) => ({ ...shot, on: !picked || picked.has(shot.no) }))
  const printed = shots.filter((shot) => shot.on)
  const tight = beats.filter((beat) => beat.tight).length
  // 抬头写的是「全片有几镜、几张帧图」；选了哪几镜由下面那行单独说，
  // 不然收件人看到「8 镜」会以为纸缺页。
  const withFrame = cappedShots.filter((shot, index) => Boolean(frameOf(shot, template).url)).length
  const timing = script?.timing || null
  return {
    id: String(project.id || ''),
    title: flat(project.title) || '未命名作品',
    version: Number(project.version) || 0,
    hook: flat(script?.hook) || flat(template?.hook),
    hookType: flat(template?.hookType),
    source: {
      title: flat(template?.title),
      kind: flat(template?.kind),
      platform: flat(template?.platformLabel) || flat(template?.platform),
      durationSec: num(template?.durationSec),
    },
    timing: timing
      ? {
          estimatedSec: num(timing.estimatedSec),
          durationSec: num(timing.durationSec),
          pace: PACE_LABEL[timing.pace] || '中',
          rate: num(timing.rate),
        }
      : null,
    beats,
    beatTotal: structure.length,
    beatsHidden: Math.max(0, structure.length - beats.length),
    shots,
    shotTotal: allShots.length,
    // 纸上一共排了几张卡（封顶后）与其中选了哪几镜：现场改选区时脚本要这两个数
    shotCards: shots.length,
    shotPrinted: printed.length,
    shotsOff: shots.length - printed.length,
    selected: picked ? shotRangeLabel(printed.map((shot) => shot.no)) : '',
    shotsHidden: Math.max(0, allShots.length - shots.length),
    withFrame,
    tight,
  }
}

const EXTRA_CSS = [
  '/* 现场页：脚本表窄一些、镜头卡片两列；间距全部 4/8pt 栅格 */',
  '.set-beats th:nth-child(1), .set-beats td:nth-child(1) { width: 58pt; }',
  '.set-beats th:nth-child(2), .set-beats td:nth-child(2) { width: 68pt; }',
  '.set-beats th:nth-child(4), .set-beats td:nth-child(4) { width: 76pt; }',
  '.set-beats td:nth-child(3) { font-size: 9.5pt; line-height: 1.6; }',
  '.set-beats tr.is-tight td { background: #fbf7f2; }',
  '.set-beats .set-fit { font-family: var(--mono); font-size: 7.5pt; color: var(--muted); }',
  '.set-empty { margin: 4pt 0 8pt; padding: 10pt 12pt; border: 0.75pt dashed var(--line-strong); border-radius: 4pt; color: var(--muted); font-size: 9.5pt; }',
  '.set-note { margin: 4pt 0 0; color: var(--faint); font-size: 8.5pt; line-height: 1.6; }',
  '.set-shots { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8pt; margin: 8pt 0 0; }',
  '.set-shot { padding: 6pt; border: 0.75pt solid var(--line-strong); border-radius: 4pt; break-inside: avoid; }',
  '.set-shot-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8pt; font-family: var(--mono); font-size: 7.5pt; letter-spacing: 0.04em; color: var(--muted); }',
  '.set-shot-top .set-tick { display: inline-flex; align-items: center; gap: 3pt; color: var(--faint); }',
  '.set-shot-top .set-tick::before { content: ""; width: 7pt; height: 7pt; border: 0.75pt solid var(--line-strong); border-radius: 1.5pt; }',
  // 帧图按 16:10 裁切：原片多是竖屏（9:16），整张塞进卡片只有指甲盖大，看不出机位；
  // 裁成横向缩略图才看得清画面，完整原图在交付包的 frames/ 里。
  '.set-shot-frame { display: block; width: 100%; aspect-ratio: 16 / 10; margin: 4pt 0; object-fit: cover; background: #f4f4f4; border-radius: 2pt; }',
  '.set-shot-frame.is-empty { display: grid; place-items: center; border: 0.5pt dashed var(--line-strong); background: #fafafa; color: var(--faint); font-size: 8pt; }',
  '.set-shot-body { display: grid; gap: 1.5pt; font-size: 8.5pt; line-height: 1.5; }',
  '.set-shot-line { display: grid; grid-template-columns: 22pt minmax(0, 1fr); gap: 6pt; }',
  '.set-shot-line .set-k { color: var(--faint); }',
  '.set-foot { margin: 16pt 0 0; padding-top: 6pt; border-top: 0.5pt solid var(--line); color: var(--faint); font-family: var(--mono); font-size: 7.5pt; letter-spacing: 0.02em; }',
  '.bar-textbrand, .sheet-textbrand { font-family: var(--font); font-size: 13pt; font-weight: 600; letter-spacing: -0.01em; }',
  // 只印某几镜：没选中的卡片在屏幕上与纸上都不占位（不是变灰——纸上的灰卡片等于废纸）
  '.set-shot.is-off { display: none; }',
  '.set-pick { margin: 0 0 12pt; padding: 4pt 8pt; border: 0.75pt solid var(--line-strong); border-radius: 4pt; background: #fbfbfb; font-size: 9pt; line-height: 1.6; }',
  '.set-pick strong { font-family: var(--mono); font-weight: 500; }',
  // 顶栏的选区：只在屏幕上有（.bar 打印时整体隐藏），一行数字，回车即换
  '.bar-range { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); white-space: nowrap; }',
  '.bar-range input { width: 88px; height: 32px; padding: 0 8px; border: 1px solid var(--line-strong); border-radius: 8px; background: #ffffff; color: var(--ink); font-family: var(--mono); font-size: 12px; }',
  '.bar-range input::placeholder { color: var(--faint); }',
  '.bar-range input:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }',
  '.bar-count { font-family: var(--mono); font-size: 11px; color: var(--faint); white-space: nowrap; }',
  '@media print { .set-shot { break-inside: avoid; } }',
].join('\n')

// 顶栏那一行「只印几镜」的脚本：纯 DOM、无依赖，交付包里双击打开（file://）一样能用。
// 解析口径与 parseShotRange 一致（逗号 / 顿号 / 空格分隔，n 或 a-b，超范围的不算），
// 两边各有用例钉住（test/project-set-sheet.test.mjs 的「只印某几镜」两条）。
const RANGE_SCRIPT = [
  '(function(){',
  'var input=document.querySelector("[data-range]");',
  'if(!input)return;',
  'var cards=[].slice.call(document.querySelectorAll("[data-shot]"));',
  'var status=document.querySelector("[data-range-status]");',
  'var pick=document.querySelector("[data-pick]");',
  'var wrap=document.querySelector("[data-shot-total]");',
  'var total=cards.length;',
  'if(!total)return;',
  'var all=Number(wrap&&wrap.getAttribute("data-shot-total"))||total;',
  'function parse(text){var out=[],seen={};String(text||"").split(/[,，、;；\\s]+/).forEach(function(t){if(!t)return;var r=t.match(/^(\\d+)\\s*[-–~至]\\s*(\\d+)$/);var add=[];if(r){var a=Number(r[1]),b=Number(r[2]);for(var i=Math.min(a,b);i<=Math.max(a,b);i+=1)add.push(i)}else if(/^\\d+$/.test(t)){add.push(Number(t))}add.forEach(function(v){if(v>=1&&v<=total&&!seen[v]){seen[v]=1;out.push(v)}})});return out.sort(function(x,y){return x-y})}',
  'function label(list){var parts=[],start=null,prev=null;list.forEach(function(n){if(start===null){start=n;prev=n;return}if(n===prev+1){prev=n;return}parts.push(start===prev?String(start):start+"–"+prev);start=n;prev=n});if(start!==null)parts.push(start===prev?String(start):start+"–"+prev);return parts.join("、")}',
  'function apply(){',
  'var list=parse(input.value);',
  'var shown=0;',
  'cards.forEach(function(card){var no=Number(card.getAttribute("data-shot"));var on=!list.length||list.indexOf(no)>=0;card.className=on?"set-shot":"set-shot is-off";if(on)shown+=1});',
  'if(status)status.textContent=list.length?"印 "+shown+" / "+total+" 镜":(input.value.trim()?"没认出这个写法，印全部 "+total+" 镜":"印全部 "+total+" 镜");',
  'if(pick){if(list.length){pick.hidden=false;pick.innerHTML="本张只印第 <strong>"+label(list)+"</strong> 镜（全片 "+all+" 镜"+(all-shown>0?"，未印的 "+(all-shown)+" 镜在作品页看":"")+"）。"}else{pick.hidden=true;pick.textContent=""}}',
  'try{var u=new URL(location.href);if(list.length)u.searchParams.set("shots",list.join(","));else u.searchParams.delete("shots");history.replaceState(null,"",u.href)}catch(e){}',
  '}',
  'input.addEventListener("change",apply);',
  'input.addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();apply();input.blur()}});',
  '})();',
].join('')

function fact(key, value) {
  if (!value) return ''
  return '<li><span class="fact-k">' + escapeHtml(key) + '</span><span class="fact-v">' + escapeHtml(value) + '</span></li>'
}

function beatTable(model) {
  const head =
    '<thead><tr><th>时间</th><th>段落</th><th>口播</th><th>屏幕字</th><th>念完</th></tr></thead>'
  const rows = model.beats.map((beat) => {
    const read = beat.read ? beat.read + ' 秒' + (beat.tight ? ' · 偏多' : '') : '—'
    return (
      '<tr' + (beat.tight ? ' class="is-tight"' : '') + '>' +
      '<td>' + escapeHtml(beat.span) + '</td>' +
      '<td>' + escapeHtml(beat.beat) + '</td>' +
      '<td>' + (beat.voiceover ? escapeHtml(beat.voiceover) : '<span class="set-fit">还没写</span>') + '</td>' +
      '<td>' + (beat.onScreen ? escapeHtml(beat.onScreen) : '—') + '</td>' +
      '<td><span class="set-fit">' + escapeHtml(read) + '</span></td>' +
      '</tr>'
    )
  })
  return '<table class="set-beats">' + head + '<tbody>' + rows.join('') + '</tbody></table>'
}

function shotCards(model, { frameBase = '', availableFrames = null } = {}) {
  return model.shots
    .map((shot) => {
      const packaged = availableFrames ? availableFrames.has(shot.file) : Boolean(shot.frameUrl)
      const src = frameBase ? (packaged ? frameBase + shot.file : '') : shot.frameUrl
      const frame = src
        ? '<img class="set-shot-frame" src="' + escapeHtml(src) + '" alt="镜头 ' + pad2(shot.no) + ' 的帧图">'
        : '<div class="set-shot-frame is-empty">没存帧图</div>'
      const lines = [
        shot.visual ? '<div class="set-shot-line"><span class="set-k">画面</span><span>' + escapeHtml(shot.visual) + '</span></div>' : '',
        shot.camera ? '<div class="set-shot-line"><span class="set-k">机位</span><span>' + escapeHtml(shot.camera) + '</span></div>' : '',
        shot.caption ? '<div class="set-shot-line"><span class="set-k">字幕</span><span>' + escapeHtml(shot.caption) + '</span></div>' : '',
        shot.audio ? '<div class="set-shot-line"><span class="set-k">音频</span><span>' + escapeHtml(shot.audio) + '</span></div>' : '',
      ].filter(Boolean)
      return (
        '<article class="set-shot' + (shot.on === false ? ' is-off' : '') + '" data-shot="' + shot.no + '">' +
        '<div class="set-shot-top"><span>镜头 ' + pad2(shot.no) + ' · ' + escapeHtml(shot.span) + '</span><span class="set-tick">拍过</span></div>' +
        frame +
        '<div class="set-shot-body">' + (lines.length ? lines.join('') : '<div class="set-shot-line"><span class="set-k">画面</span><span>这一镜没有写画面说明</span></div>') + '</div>' +
        '</article>'
      )
    })
    .join('')
}

/** 纸上的抬头事实：模板来源、时长、段落与镜头数。空的项不印，不写「—」凑数。 */
function facts(model) {
  const source = [model.source.title, model.source.kind === 'replica' ? '原片拆解' : model.source.kind === 'adapted' ? '改编版' : '', model.source.platform]
    .filter(Boolean)
    .join(' · ')
  const timing = model.timing
    ? '原片 ' + round1(model.source.durationSec) + ' 秒 / 台词约需 ' + round1(model.timing.estimatedSec) +
      ' 秒（' + model.timing.pace + (model.timing.rate ? '，' + round1(model.timing.rate) + ' 字/秒' : '') + '）'
    : model.source.durationSec
      ? '原片 ' + round1(model.source.durationSec) + ' 秒'
      : ''
  const beats = model.beatTotal
    ? model.beatTotal + ' 段' + (model.tight ? '（' + model.tight + ' 段口播偏多）' : '') + (model.beatsHidden ? '，纸上只印前 ' + model.beats.length + ' 段' : '')
    : ''
  const shots = model.shotTotal
    ? model.shotTotal + ' 镜' + (model.withFrame ? ' · 帧图 ' + model.withFrame + ' 张' : ' · 没有帧图') + (model.shotsHidden ? '，纸上只印前 ' + model.shots.length + ' 镜' : '')
    : ''
  return [fact('模板', source), fact('时长', timing), fact('脚本', beats), fact('分镜', shots)].filter(Boolean).join('')
}

/**
 * 现场页 HTML。
 * frameBase：'' = 线上（帧图走 /media/frames）；'frames/' = 交付包里（帧图跟 HTML 并排放）。
 * availableFrames：交付包里真正打进去的帧图文件名集合——缺的那几镜写「没存帧图」，不拿旧图顶。
 */
export function setSheetHtml({
  project = {},
  script = null,
  template = null,
  projectId = '',
  frameBase = '',
  availableFrames = null,
  offline = false,
  onlyShots = null,
  generatedAt = '',
  tzOffsetMinutes = 480,
} = {}) {
  const model = setSheetModel({ project, script, template, onlyShots })
  const body =
    printToolbar({
      projectId,
      tag: '现场页 · 脚本 + 分镜',
      hint: offline ? '解压后直接打印 / 存为 PDF；帧图在 frames/ 里' : '纸张选 A4；想要页码就在打印对话框里打开「页眉和页脚」',
      back: !offline,
      brand: offline ? 'text' : 'img',
      extra: rangeField(model),
    }) +
    '\n<main class="sheet">\n' +
    '<div class="sheet-brand">' +
    (offline ? '<span class="sheet-textbrand">VisionQA</span>' : '<img class="sheet-mark" src="/brand/visionqa-lockup.svg" alt="VisionQA">') +
    '<span class="sheet-kind">SET SHEET / A4</span></div>\n' +
    '<div class="sheet-body">\n' +
    '<h1 class="sheet-title">' + escapeHtml(model.title) + '</h1>\n' +
    (model.hook
      ? '<p class="lede">开头钩子：<strong>' + escapeHtml(model.hook) + '</strong>' + (model.hookType ? '（' + escapeHtml(model.hookType) + '）' : '') + '</p>\n'
      : '') +
    '<ul class="sheet-facts">' + facts(model) + '</ul>\n' +
    pickLine(model) +
    '<h2>脚本</h2>\n' +
    (model.beats.length
      ? beatTable(model) +
        '<p class="set-note">按台词念完估的时长（语速档' + (model.timing ? '「' + model.timing.pace + '」' : '按模板') + '）。标「偏多」的段落念完会比画面长：要么删两句，要么把这段画面拍长一点。</p>\n'
      : '<p class="set-empty">还没写脚本：这张纸只印已经有的东西。回作品页写第一段口播，再打开现场页。</p>\n') +
    '<h2>分镜</h2>\n' +
    (model.shots.length
      ? '<p class="set-note">分镜来自模板「' + escapeHtml(model.source.title || '未命名模板') + '」：改过脚本不会自动重排镜头时间，现场按这张表拍。</p>\n' +
        '<div class="set-shots" data-shot-total="' + model.shotTotal + '">' + shotCards(model, { frameBase, availableFrames }) + '</div>\n'
      : '<p class="set-empty">模板没有分镜表：按上面的脚本直接拍，或者换一条已解析的模板。</p>\n') +
    '<p class="set-foot">VisionQA · 现场页 · v' + (model.version || 0) + ' · ' +
    escapeHtml(stampText(generatedAt, tzOffsetMinutes)) + ' · ' + escapeHtml(model.id || projectId) + '</p>\n' +
    '</div>\n</main>'
  return paperShell(model.title + ' · 现场页 · VisionQA', body, EXTRA_CSS, RANGE_SCRIPT)
}

/** 顶栏的「只印哪几镜」：现场改一行字就换一版纸。留空 = 全部。 */
function rangeField(model) {
  if (!model.shotCards) return ''
  const status = model.selected ? '印 ' + model.shotPrinted + ' / ' + model.shotCards + ' 镜' : '印全部 ' + model.shotCards + ' 镜'
  return (
    '<label class="bar-range" title="只印其中几镜：写镜号，例如 2-4,7；留空印全部">' +
    '<span>只印</span>' +
    '<input type="text" data-range value="' + escapeHtml(model.selected) + '" placeholder="全部" inputmode="numeric" autocomplete="off" spellcheck="false" aria-label="只印哪几镜，例如第 2 到第 4 镜和第 7 镜写作 2-4,7">' +
    '</label>' +
    '<span class="bar-count" data-range-status>' + escapeHtml(status) + '</span>'
  )
}

/** 纸上那行「这一版只印了哪几镜」：放在抬头下面，收件人翻页前就知道纸是选过的，不会以为缺页。 */
function pickLine(model) {
  if (!model.selected) return '<p class="set-pick" data-pick hidden></p>\n'
  const off = Math.max(0, model.shotTotal - model.shotPrinted)
  return (
    '<p class="set-pick" data-pick>本张只印第 <strong>' + escapeHtml(model.selected) + '</strong> 镜（全片 ' +
    model.shotTotal + ' 镜' + (off ? '，未印的 ' + off + ' 镜在作品页看' : '') + '）。</p>\n'
  )
}

function stampText(value, tzOffsetMinutes) {
  const text = String(value || '')
  const ms = Date.parse(text)
  if (!Number.isFinite(ms)) return text || '导出时间未知'
  const date = new Date(ms + (Number(tzOffsetMinutes) || 0) * 60000)
  return (
    String(date.getUTCFullYear()) + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate()) +
    ' ' + pad2(date.getUTCHours()) + ':' + pad2(date.getUTCMinutes())
  )
}

/** 交付包里那张「这张纸是什么」的说明：不解释太多，只写文件对应关系与口径。 */
export function packageNote({ model, generatedAt = '', tzOffsetMinutes = 480, frameCount = 0 } = {}) {
  const lines = [
    'VisionQA 交付包',
    '',
    '作品：' + model.title + '（v' + (model.version || 0) + ' · ' + (model.id || '') + '）',
    '导出：' + stampText(generatedAt, tzOffsetMinutes),
    '',
    '交付稿.md      全文：来源、脚本、分镜、评审、运行记录、逐版对照',
    '现场页.html    只带脚本与分镜的一张纸（含原片帧图），双击打开就能打印 / 存 PDF',
    frameCount
      ? 'frames/        原片帧图 ' + frameCount + ' 张，按镜头编号命名（shot-01.jpg …），和现场页里的画面一一对应'
      : 'frames/        这条作品没有帧图可打：模板是待解析的，或者原片抽帧没有落盘',
    '',
    '口径：口播与时长以脚本为准（按台词估算），镜头时间来自模板；改过脚本不会自动重排镜头时间。',
    '现场页在离线状态下也用同一套数字：它和交付稿是同一次导出的同一份数据。',
    '',
  ]
  return lines.join('\n')
}
