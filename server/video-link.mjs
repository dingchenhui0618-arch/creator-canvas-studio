// 用户自己带一条链接来拆（r291）。
//
// 以前只有「爆款雷达检索到一条 → 点复刻」这一个入口：检索服务不可用、额度用完、
// 或者用户手上已经有一条自己的片子时，就没有任何地方能发起解析。服务端的
// /api/replicate 早就支持直接用 body.url 覆盖（overrideUrl），缺的只是入口与判断。
//
// 这个文件是「这条链接是什么」的唯一真源（服务端侧）。前端有一份同规则的镜像
// （src/domain/video-link.ts）用于输入时即时反馈，test/video-link.test.mjs 会拿同一批
// 样本喂两边、断言判定一致——两边漂移会当场挂测试。

const DIRECT_MEDIA = /\.(mp4|m4v|mov|webm)(\?|#|$)/i

// 认得出的平台宿主：后缀匹配，v.douyin.com / www.xiaohongshu.com 都算
const HOSTS = [
  ['douyin.com', 'douyin', '抖音链接'],
  ['iesdouyin.com', 'douyin', '抖音链接'],
  ['xiaohongshu.com', 'xiaohongshu', '小红书链接'],
  ['xhslink.com', 'xiaohongshu', '小红书链接'],
]

// 抖音的分享文案是「7.94 复制打开抖音，看看【…】 https://v.douyin.com/xxx/ 复制此链接…」：
// 直接粘一整段是常态，不能因为前后有中文就说「链接不合法」。
const URL_IN_TEXT = /https?:\/\/[^\s"'<>，。；、）】[\]]+/i

/** 从一段粘贴文本里捞出第一条 http(s) 链接；没有就回空串。 */
export function extractFirstUrl(input) {
  const text = String(input || '')
  const match = text.match(URL_IN_TEXT)
  // 尾巴上常跟着句号、逗号、右括号（中英文都有）：那是文案，不是链接的一部分
  if (match) return match[0].replace(/[.,;:!?'"\]）)】》」』]+$/, '')
  // 没有协议头的裸域名（v.douyin.com/xxx）也接住：用户常常把 https:// 漏掉
  const bare = text.trim().match(/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s]*)?$/i)
  return bare ? 'https://' + bare[0] : ''
}

/**
 * 判定一条用户粘贴的链接能不能拆。
 * @returns {{ok: true, kind: 'direct'|'douyin'|'xiaohongshu', label: string, url: string}
 *          |{ok: false, reason: string, url: string}}
 */
export function classifyVideoLink(input) {
  const url = extractFirstUrl(input)
  if (!url) {
    // 粘了 ftp:// / file:// 这种：给「只支持 http(s)」，别一句「先把链接粘进来」把人绕回去
    const raw = String(input || '').trim()
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      return { ok: false, url: '', reason: '只支持 http / https 链接' }
    }
    return { ok: false, url: '', reason: '先把链接粘进来：抖音 / 小红书的内容页链接，或 .mp4 直链' }
  }
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, url, reason: '这条链接不是完整的网址，检查有没有粘全（要 http(s) 开头）' }
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return { ok: false, url, reason: '只支持 http / https 链接' }
  }
  if (parsed.username || parsed.password) {
    return { ok: false, url, reason: '链接里不能带账号口令' }
  }
  const host = parsed.hostname.toLowerCase().replace(/\/$/, '')
  const hit = HOSTS.find(([suffix]) => host === suffix || host.endsWith('.' + suffix))
  if (hit) return { ok: true, kind: hit[1], label: hit[2], url }
  if (DIRECT_MEDIA.test(parsed.pathname + parsed.search)) {
    return { ok: true, kind: 'direct', label: '视频直链', url }
  }
  return {
    ok: false,
    url,
    reason: '认不出这条链接：给抖音 / 小红书的内容页链接，或者 .mp4 / .mov / .webm 直链',
  }
}
