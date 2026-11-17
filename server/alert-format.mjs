// 告警载荷适配：飞书 / 钉钉 / 企业微信 / Slack 的群机器人各认各的 JSON，
// 把 { text, alert, source } 直接填进飞书机器人回 400（19001 缺 msg_type），
// 填错了也可能回 200 但 body 里带错误码——那才是最坑的：后台写「已发出」，群里一条没有。
// 所以这里做两件事：
//   1) 按地址认出是哪家机器人，出它要的那份载荷；
//   2) 回 200 之后再看业务码（飞书 code / 钉钉与企微 errcode / Slack ok），不看就等于不验。
// 取舍：
//   - 只按地址认人，不做可配置的格式下拉：地址是用户贴进来的，多一个下拉就多一个配错的入口；
//   - 认不出就当通用 webhook（我们自己的 { text, alert, source }），自建接收端不用改；
//   - 钉钉「加签」是机器人自己的 timestamp+sign 查询参数，与我们这把 x-vq-signature 无关，这里不碰。

const PROVIDERS = {
  feishu: '飞书机器人',
  dingtalk: '钉钉机器人',
  wecom: '企业微信群机器人',
  slack: 'Slack Incoming Webhook',
  generic: '通用 webhook',
}

export const PROVIDER_IDS = Object.keys(PROVIDERS)

export function providerLabel(id) {
  return PROVIDERS[id] || PROVIDERS.generic
}

// 认人只看 host + path，不碰查询串（那是凭证，日志里都不该出现）。
export function detectProvider(rawUrl) {
  const value = String(rawUrl || '').trim()
  if (!value) return 'generic'
  let url
  try {
    url = new URL(value)
  } catch {
    return 'generic'
  }
  const host = url.hostname.toLowerCase()
  const path = url.pathname.toLowerCase()
  // 飞书自定义机器人：任何形态都在 .../open-apis/bot/v2/hook/<token>；Lark 国际版域名不同，路径一样
  if (path.includes('/open-apis/bot/')) return 'feishu'
  if ((host === 'open.feishu.cn' || host.endsWith('.feishu.cn') || host.endsWith('.larksuite.com')) && path.includes('/hook/')) return 'feishu'
  // 钉钉自定义机器人：oapi.dingtalk.com/robot/send?access_token=...
  if (path.endsWith('/robot/send') || (host.endsWith('dingtalk.com') && path.includes('/robot/'))) return 'dingtalk'
  // 企业微信群机器人：qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...
  if (path.includes('/cgi-bin/webhook/send')) return 'wecom'
  // Slack：hooks.slack.com/services/T000/B000/xxxx
  if (host === 'hooks.slack.com' || (host.endsWith('.slack.com') && path.startsWith('/services/'))) return 'slack'
  return 'generic'
}

// 出载荷。text 已经是人读的一整句（含告警类型、标题、细节、次数与时间），机器人的文本消息只要它。
export function buildPayload(provider, { text, alert = null } = {}) {
  const body = String(text || '')
  if (provider === 'feishu') return { msg_type: 'text', content: { text: body } }
  // 钉钉与企业微信的文本消息结构恰好一样（都是 msgtype + text.content）
  if (provider === 'dingtalk' || provider === 'wecom') return { msgtype: 'text', text: { content: body } }
  if (provider === 'slack') return { text: body }
  return {
    text: body,
    alert: alert
      ? {
          id: alert.id,
          kind: alert.kind,
          level: alert.level,
          title: alert.title,
          detail: alert.detail,
          count: alert.count,
          lastAt: alert.lastAt,
        }
      : null,
    source: 'visionqa',
  }
}

function parseJson(raw) {
  try {
    const parsed = JSON.parse(String(raw || ''))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function clip(value, max = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) + '…' : text
}

// 判定这次到底成没成。HTTP 200 不等于送到：飞书 / 钉钉 / 企微都会用 200 回业务错误码。
export function readVerdict(provider, status, rawBody) {
  const code = Number(status) || 0
  if (code < 200 || code >= 300) {
    return { ok: false, error: clip(rawBody) || 'HTTP ' + code }
  }
  if (provider === 'generic') return { ok: true, error: '' }
  // Slack 成功时回的是纯文本 ok（不是 JSON），要放在「必须是 JSON」那道检查前面
  if (provider === 'slack' && String(rawBody).trim().toLowerCase() === 'ok') return { ok: true, error: '' }
  const json = parseJson(rawBody)
  if (!json) return { ok: false, error: '接收端回了 ' + code + '，但正文不是 JSON，没法确认它收下了' }

  if (provider === 'feishu') {
    // 老接口回 StatusCode，新接口回 code；两个都在时以 code 为准
    const hasCode = typeof json.code === 'number'
    const hasStatus = typeof json.StatusCode === 'number'
    if (!hasCode && !hasStatus) return { ok: false, error: '飞书回了 ' + code + '，但正文里没有 code，认不出结果' }
    const value = hasCode ? json.code : json.StatusCode
    if (value === 0) return { ok: true, error: '' }
    const message = json.msg || json.StatusMessage || ''
    return { ok: false, error: '飞书拒收（code ' + value + '）' + (message ? '：' + clip(message) : '') }
  }

  if (provider === 'dingtalk' || provider === 'wecom') {
    if (typeof json.errcode !== 'number') return { ok: false, error: '接收端回了 ' + code + '，但正文里没有 errcode，认不出结果' }
    if (json.errcode === 0) return { ok: true, error: '' }
    const name = provider === 'dingtalk' ? '钉钉' : '企业微信'
    const message = json.errmsg || json.msg || ''
    return { ok: false, error: name + '拒收（errcode ' + json.errcode + '）' + (message ? '：' + clip(message) : '') }
  }

  if (provider === 'slack') {
    if (json.ok === true || String(rawBody).trim().toLowerCase() === 'ok') return { ok: true, error: '' }
    return { ok: false, error: 'Slack 拒收' + (json.error ? '：' + clip(json.error) : '') }
  }

  return { ok: true, error: '' }
}
