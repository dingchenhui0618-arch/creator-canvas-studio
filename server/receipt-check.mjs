// 收据对账（v0.9.136）：收包人把校验页给出的那段「收据」发回来，发件人贴进作品页，
// 服务端只做一件事——把收据里那串整包 SHA-256 与封存包里记的那一串比一遍。
//
// 为什么要有它：校验页（v0.9.133）与收据（v0.9.135）让收包人自己验完能说一句话，
// 但这句话只有贴回发件人手上才有用。收据里已经有作品与版次、包名、整包字节、SHA-256、
// 时间与结论；对一遍就能回答「他验的到底是不是我封存的那一份」。
//
// 边界：
//  - 只解析、只比对，不联网、不重打包、不改盘上那份包；
//  - 收据是对方发来的文字：只认校验页写出来的那几行，认不出来就明确拒绝（不猜）；
//  - 比对结论只给四种：对得上 / 对不上 / 对方读不出来 / 哈希对上但结论打架——
//    不把「比不了」说成「对得上」。
/** 一段收据最多收这么多字：再多就不是收据，是别的东西了。 */
export const RECEIPT_MAX_CHARS = 8000

/** 收据抬头：VisionQA 交付包核对 · 作品名 v3 */
const HEAD = /^VisionQA\s+(\S+?)\s*核对(?:\s*·\s*(.*))?$/u
/** 版次写在抬头末尾：作品名里带 v3 也只是名字，只有末尾那个是版次。 */
const VERSION_TAIL = /^(.*?)\s+v(\d{1,6})\s*$/u

/** 收据里的一行：允许微信引用带的前缀与全角冒号，键名与值之间随便几个空格。 */
const linePattern = (name) => new RegExp('^' + name + '\\s*[：:]\\s*(.*)$', 'u')

const cleanLine = (line) => String(line || '')
  .replace(/^\s*(?:[>|•\-*]\s*)+/u, '')
  .replace(/\u00a0/g, ' ')
  .trim()

const clip = (value, max) => String(value ?? '').trim().slice(0, max)

/** 位数不写死：收据上的字节数带千分位逗号，收件人手打时可能漏掉逗号。 */
function parseBytes(value) {
  const digits = String(value || '').replace(/[,\s]/g, '')
  if (!/^\d{1,15}$/.test(digits)) return 0
  return Number(digits)
}

function parseSha(value) {
  const found = String(value || '').match(/[0-9a-fA-F]{64}/)
  return found ? found[0].toLowerCase() : ''
}

/**
 * 解析一段收据。ok=false 时 error 说清缺哪一行，不让调用方拿半份数据去比。
 * 只认校验页写出来的形状，多一点少一点都不猜。
 */
export function parseReceipt(raw) {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n')
  if (!text.trim()) return { ok: false, error: '这一段是空的：把校验页给出的收据整段贴进来。', problems: ['空的一段'] }
  if (text.length > RECEIPT_MAX_CHARS) {
    return { ok: false, error: '这段太长了（超过 ' + RECEIPT_MAX_CHARS + ' 字）：只贴收据那几行。', problems: ['太长了'] }
  }
  const lines = text.split('\n').map(cleanLine).filter(Boolean)
  const head = lines.map((line) => line.match(HEAD)).find(Boolean) || null
  let kind = ''
  let title = ''
  let version = 0
  if (head) {
    kind = clip(head[1], 20)
    const tail = clip(head[2] || '', 200)
    const withVersion = tail.match(VERSION_TAIL)
    if (withVersion) {
      title = clip(withVersion[1], 120)
      version = Math.max(0, Math.round(Number(withVersion[2]) || 0))
    } else {
      title = tail
    }
  }

  const fields = {}
  for (const line of lines) {
    const pairs = [
      ['packageName', linePattern('包')],
      ['conclusion', linePattern('结论')],
      ['bundle', linePattern('整包')],
      ['at', linePattern('时间')],
      ['bad', linePattern('对不上的')],
    ]
    for (const [key, pattern] of pairs) {
      if (fields[key] !== undefined) continue
      const hit = line.match(pattern)
      if (hit) fields[key] = hit[1].trim()
    }
  }

  const problems = []
  if (!fields.conclusion) problems.push('没找到「结论：」那一行')
  if (!fields.bundle) problems.push('没找到「整包：」那一行')
  const bundle = fields.bundle || ''
  const bytes = parseBytes((bundle.match(/^([\d,]+)\s*B/iu) || [])[1] || '')
  const sha256 = parseSha(bundle)
  const shaUnknown = /没算/u.test(bundle)
  if (fields.bundle && !bytes && !sha256 && !shaUnknown) {
    problems.push('「整包：」那一行既没有字节数也没有 SHA-256')
  }
  if (problems.length) {
    return {
      ok: false,
      error: '这段不像校验页给出的收据：' + problems.join('；') + '。把收据那几行原样贴进来就行。',
      problems,
    }
  }

  // 结论 = 结论胶囊 · 一句话；胶囊被改过也不影响比对，结论只用来判断「对方说有没问题」
  const conclusion = clip(fields.conclusion, 400)
  const [chipPart, ...rest] = conclusion.split('·')
  const chip = clip(chipPart, 20)
  const summary = clip(rest.join('·'), 300)
  const verdict = /都对得上/u.test(chip) ? 'ok' : /读不出来/u.test(chip) ? 'error' : /有问题/u.test(chip) ? 'bad' : 'other'

  return {
    ok: true,
    error: '',
    kind,
    title,
    version,
    packageName: clip(fields.packageName || '', 180),
    chip,
    summary,
    verdict,
    bytes,
    sha256,
    shaUnknown,
    at: clip(fields.at || '', 40),
    mismatchNote: clip(fields.bad || '', 300),
  }
}

// 两边都长这样：前 6 位 + 尾 4 位。只改一个字符时，光看前 12 位会以为一模一样。
const shaEdge = (value) => {
  const sha = String(value || '').toLowerCase()
  return /^[0-9a-f]{64}$/.test(sha) ? sha.slice(0, 6) + '…' + sha.slice(-4) : ''
}

/**
 * 哈希差在哪：从第几位起不一样。只改中间某一位时，两边的前缀与尾巴可能都一样，
 * 所以这里按位置说，而不是把两串 64 位都甩给用户看。
 */
const shaDiff = (want, got) => {
  const a = String(want || '').toLowerCase()
  const b = String(got || '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return ''
  let index = 0
  while (index < a.length && a[index] === b[index]) index += 1
  if (index >= a.length) return ''
  const from = Math.max(0, index - 3)
  const cut = (value) =>
    (from > 0 ? '…' : '') + value.slice(from, index + 3) + (value.length > index + 3 ? '…' : '')
  return (index === 0 ? '第 1 位就不一样' : '前 ' + index + ' 位一样') +
    '，从第 ' + (index + 1) + ' 位起不一样：收据是 ' + cut(b) + '，这一条是 ' + cut(a)
}

/**
 * 对一遍：收据 vs 这一条封存包。
 * state 只有四种；problems 是给人看的具体差别，最多 4 条。
 */
export function checkReceipt({ text, delivery = null } = {}) {
  const parsed = parseReceipt(text)
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, parsed: null, state: '', summary: '', problems: parsed.problems || [], checks: [], claimed: null }
  }
  const pkg = delivery && typeof delivery === 'object' && delivery.package ? delivery.package : {}
  const wantSha = String(pkg.sha256 || '').trim().toLowerCase()
  const wantBytes = Math.max(0, Math.round(Number(pkg.bytes) || 0))
  const wantVersion = Math.max(0, Math.round(Number(delivery?.version) || 0))
  const wantName = String(pkg.fileName || '')

  const versionOk = parsed.version > 0 && parsed.version === wantVersion
  const packageOk = Boolean(parsed.packageName) && parsed.packageName === wantName
  const bytesOk = parsed.bytes > 0 && parsed.bytes === wantBytes
  const shaOk = Boolean(parsed.sha256) && Boolean(wantSha) && parsed.sha256 === wantSha
  const verdictOk = parsed.verdict === 'ok'

  const checks = [
    { k: 'version', want: wantVersion ? 'v' + wantVersion : '没记', got: parsed.version ? 'v' + parsed.version : '没写', ok: versionOk },
    { k: 'package', want: wantName || '没记', got: parsed.packageName || '没写', ok: packageOk },
    { k: 'bytes', want: wantBytes ? String(wantBytes) : '没记', got: parsed.bytes ? String(parsed.bytes) : '没写', ok: bytesOk },
    { k: 'sha256', want: shaEdge(wantSha), got: shaEdge(parsed.sha256), ok: shaOk },
    { k: 'verdict', want: '都对得上', got: parsed.chip || '没写', ok: verdictOk },
  ]

  const problems = []
  if (!versionOk) problems.push('版次对不上：收据是 ' + (parsed.version ? 'v' + parsed.version : '没写版次') + '，这一条是 v' + wantVersion)
  if (!packageOk) problems.push('包名对不上：收据写「' + (parsed.packageName || '没写') + '」，这一条封存的是「' + (wantName || '没记') + '」')
  if (!bytesOk) problems.push('字节数对不上：收据写 ' + (parsed.bytes ? parsed.bytes.toLocaleString('zh-CN') + ' B' : '没写') + '，这一条是 ' + wantBytes.toLocaleString('zh-CN') + ' B')
  if (!shaOk && parsed.sha256) {
    problems.push('哈希对不上：' + (shaDiff(wantSha, parsed.sha256) || '收据是 ' + shaEdge(parsed.sha256) + '，这一条封存的是 ' + (shaEdge(wantSha) || '没记')))
  }
  if (parsed.shaUnknown) problems.push('收据上没算哈希（对方那边读不出来），确认不了是同一份')
  if (!verdictOk) problems.push('收据的结论是「' + clip(parsed.chip + (parsed.summary ? ' · ' + parsed.summary : ''), 160) + '」')

  let state = 'mismatch'
  let summary = ''
  if (parsed.verdict === 'error') {
    state = 'broken'
    summary = '收包人那边读不出来——' + (parsed.summary || parsed.mismatchNote || '包可能没下全').replace(/[。.]$/, '') + '。这一份重发更稳。'
  } else if (shaOk && versionOk && packageOk && bytesOk && verdictOk) {
    state = 'match'
    summary = '就是这一份：版次、包名、字节数与整包 SHA-256 都对得上。'
  } else if (shaOk && !verdictOk) {
    state = 'conflict'
    summary = '哈希对得上，但收据的结论写着「' + (parsed.chip || '有问题') + '」：两份说法打架，先问清对方验的是哪个文件。'
  } else {
    state = 'mismatch'
    // 第一句就是最具体的差别（缺了就用一句笼统的），不在前面再叠一个「对不上：」
    summary = (problems[0] || '收据里的值与这一条封存包不一致').replace(/[。.]$/, '') + '。'
  }

  const claimed = {
    at: parsed.at,
    kind: parsed.kind,
    title: parsed.title,
    version: parsed.version,
    bytes: parsed.bytes,
    sha256: parsed.sha256,
    packageName: parsed.packageName,
    chip: parsed.chip,
    summary: parsed.summary,
  }
  return {
    ok: state === 'match',
    error: '',
    parsed,
    state,
    summary: clip(summary, 300),
    problems: problems.slice(0, 4).map((line) => clip(line, 180)),
    checks,
    claimed,
  }
}
