// 用户自己带一条链接来拆（r291）：前端这一份是 server/video-link.mjs 的镜像。
//
// 为什么要两份：服务端必须自己判（不能信客户端传来的 platform），前端要即时反馈
// 「这条链接认不认得出」而不为每个按键都跑一次请求。两份规则一旦漂移，用户就会
// 看到「输入框说可以、一点就报错」。test/video-link.test.mjs 用同一批样本喂两边，
// 断言判定完全一致——漂移会当场挂测试。
import type { MediaItem, Platform } from './radar'

export type VideoLinkKind = 'direct' | 'douyin' | 'xiaohongshu'

export type VideoLinkCheck =
  | { ok: true; kind: VideoLinkKind; label: string; url: string; platform: Platform }
  | { ok: false; reason: string; url: string }

const DIRECT_MEDIA = /\.(mp4|m4v|mov|webm)(\?|#|$)/i

// 认得出的平台宿主：后缀匹配，v.douyin.com / www.xiaohongshu.com 都算
type PlatformKind = 'douyin' | 'xiaohongshu'

const HOSTS: readonly (readonly [string, PlatformKind, string])[] = [
  ['douyin.com', 'douyin', '抖音链接'],
  ['iesdouyin.com', 'douyin', '抖音链接'],
  ['xiaohongshu.com', 'xiaohongshu', '小红书链接'],
  ['xhslink.com', 'xiaohongshu', '小红书链接'],
]

// 抖音的分享文案是一整段中文夹一条链接：直接粘整段是常态，不能因为前后有中文就判不合法
const URL_IN_TEXT = /https?:\/\/[^\s"'<>，。；、）】[\]]+/i

/** 从一段粘贴文本里捞出第一条 http(s) 链接；没有就回空串。 */
export function extractFirstUrl(input: string): string {
  const text = String(input || '')
  const match = text.match(URL_IN_TEXT)
  // 尾巴上常跟着句号、逗号、右括号（中英文都有）：那是文案，不是链接的一部分
  if (match) return match[0].replace(/[.,;:!?'"\]）)】》」』]+$/, '')
  // 没有协议头的裸域名（v.douyin.com/xxx）也接住：用户常常把 https:// 漏掉
  const bare = text.trim().match(/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s]*)?$/i)
  return bare ? 'https://' + bare[0] : ''
}

/** 判定一条用户粘贴的链接能不能拆：规则与 server/video-link.mjs 完全一致。 */
export function checkVideoLink(input: string): VideoLinkCheck {
  const url = extractFirstUrl(input)
  if (!url) {
    // 粘了 ftp:// / file:// 这种：给「只支持 http(s)」，别一句「先把链接粘进来」把人绕回去
    const raw = String(input || '').trim()
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      return { ok: false, url: '', reason: '只支持 http / https 链接' }
    }
    return { ok: false, url: '', reason: '先把链接粘进来：抖音 / 小红书的内容页链接，或 .mp4 直链' }
  }
  let parsed: URL
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
  if (hit) return { ok: true, kind: hit[1], label: hit[2], url, platform: hit[1] }
  if (DIRECT_MEDIA.test(parsed.pathname + parsed.search)) {
    return { ok: true, kind: 'direct', label: '视频直链', url, platform: 'link' }
  }
  return {
    ok: false,
    url,
    reason: '认不出这条链接：给抖音 / 小红书的内容页链接，或者 .mp4 / .mov / .webm 直链',
  }
}

/**
 * 把自备链接包成一张「检索卡片」：/api/replicate 要的 item 形状与雷达卡片一致，
 * 这样解析、扣费、退款、入库全走同一条管线，不为自备链接另开一套。
 */
export function manualMediaItem(input: string): MediaItem {
  const check = checkVideoLink(input)
  return {
    id: '',
    platform: check.ok ? check.platform : 'link',
    platformLabel: check.ok ? check.label : '自备链接',
    title: '',
    author: '',
    cover: '',
    url: check.url,
    publishedAt: '',
    durationSec: null,
    stats: { likes: 0, comments: 0, shares: 0, collects: 0 },
  }
}
