/**
 * 「这条回执链接」没读回来时，先分清是哪一种（v0.9.257 / r275）。
 *
 * 收包人那一侧没有账号、也没有发件人手里的那套东西：把一次 5xx 或断网说成
 * 「这条回执链接不在了」，他会回头找发件人再要一条——而发件人手上那条一直是好的，
 * 重发一次只是把同一条地址再贴一遍，谁也没修好什么。反过来，真被收回、真被换掉的链接
 * 也不能说成「网络抖了一下」，让他一次又一次点下去。
 *
 * 判据只有一条：服务端明确说过「没有这条」（404）或「换成新的了」（410 / LINK_RETIRED），
 * 才说链接不在了；连不上、5xx、超时、看不懂的响应，一律是「这一下没打开」，可以再点一次。
 */
export type ReceiptLinkFail = {
  /** 0 表示请求根本没到服务端（断网、服务没起来、跨域被拦） */
  status: number
  /** 服务端给的错误码，比如 LINK_RETIRED */
  code: string
  /** 换链接那一次的时刻（只有 410 带） */
  retiredAt: string
  /** 服务端或网络层给的原始一句话；只用来排障，不整段摆给收包人 */
  message: string
  network: boolean
}

export type ReceiptLinkRead =
  | { kind: 'retired'; retiredAt: string }
  | { kind: 'gone'; title: string; copy: string; note: string; detail: string }
  | { kind: 'unreadable'; title: string; copy: string; note: string; retry: string; detail: string }

const GONE_TITLE = '这条回执链接不在了'
const GONE_COPY = '发件人可能换了一条新的链接，或者这一条交付已经收回。'
const GONE_NOTE = '找发件人要一条新的回执链接就行；手上的包不用重下。'
const UNREADABLE_TITLE = '这一下没打开'
const UNREADABLE_NOTE = '过一会儿点「再试一次」就行；反复打不开，再把这一句回给发件人。手上的包不用重下。'

/** 把 catch 到的东西整理成一份可判的形状；认不出来的一律按「没读到」处理。 */
export function receiptLinkFail(caught: unknown): ReceiptLinkFail {
  const record = caught as { status?: unknown; body?: { code?: unknown; retiredAt?: unknown }; message?: unknown; network?: unknown } | null
  const rawStatus = Number(record?.status)
  const status = Number.isFinite(rawStatus) && rawStatus > 0 ? Math.round(rawStatus) : 0
  const body = record?.body
  const code = typeof body?.code === 'string' ? body.code : ''
  const retiredAt = typeof body?.retiredAt === 'string' ? body.retiredAt : ''
  const bodyError = typeof (body as { error?: unknown } | undefined)?.error === 'string' ? String((body as { error?: string }).error) : ''
  const raw = typeof record?.message === 'string' ? record.message : caught instanceof Error ? caught.message : ''
  // 有的包装只把话放在 body.error 里、message 只剩「HTTP 404」：留那句人话
  const message = /^HTTP \d+$/.test(raw) && bodyError ? bodyError : raw || bodyError
  return { status, code, retiredAt, message, network: status === 0 || record?.network === true }
}

/** 收包人这一侧只有三句话：换成新的了 / 不在了 / 这一下没打开。 */
export function receiptLinkRead(caught: unknown): ReceiptLinkRead {
  const fail = receiptLinkFail(caught)
  if (fail.status === 410 || fail.code === 'LINK_RETIRED') {
    return { kind: 'retired', retiredAt: fail.retiredAt }
  }
  if (fail.status === 404) {
    // 服务端自己的那句「不在了 / 失效」与标题重复，只把不同的说法留下来
    const detail = fail.message && !/不在了|失效/.test(fail.message) && !/^HTTP \d+$/.test(fail.message) ? fail.message : ''
    return { kind: 'gone', title: GONE_TITLE, copy: GONE_COPY, note: GONE_NOTE, detail }
  }
  // 只给状态码，不给服务端内部错误码：收包人要转述的是「服务出错」这一句，码留在日志里
  const detail = fail.network ? '网络没连上' : 'HTTP ' + fail.status
  const copy = fail.network
    ? '链接本身没问题，是这一次没连上：网络断了，或者服务正好在重启。'
    : '链接本身没问题，是这一次没读到：服务临时出了错（HTTP ' + fail.status + '）。'
  return { kind: 'unreadable', title: UNREADABLE_TITLE, copy, note: UNREADABLE_NOTE, retry: '再试一次', detail }
}
