// 登录设备的展示口径（v0.9.62）：把 UA 与 IP 变成人能认的一行。
// 纯函数，页面和测试共用；认不出来时如实说「未知设备」，不猜。
export type DeviceInfo = { device: string; browser: string }

export function parseUserAgent(value: string): DeviceInfo {
  const ua = String(value || '').trim()
  // 命令行 / 脚本登录（node、curl、Python 请求、截图脚本）也要有个名字：
  // 直接写「未知设备」会让人以为有人在用浏览器登录，反而更难判断。
  if (/curl\/|python-requests\/|python-urllib\/|^node$|^node\/|go-http-client\/|okhttp\/|wget\/|qa-screenshot/i.test(ua)) {
    const browser = /curl/i.test(ua)
      ? 'curl'
      : /python/i.test(ua)
        ? 'Python'
        : /node/i.test(ua)
          ? 'Node'
          : /qa-screenshot/i.test(ua)
            ? '截图脚本'
            : /wget/i.test(ua)
              ? 'wget'
              : ''
    return { device: '命令行', browser }
  }
  const device = /iPhone/i.test(ua)
    ? 'iPhone'
    : /iPad/i.test(ua)
      ? 'iPad'
      : /Android/i.test(ua)
        ? 'Android'
        : /CrOS/i.test(ua)
          ? 'ChromeOS'
          : /Mac OS X|Macintosh/i.test(ua)
            ? 'Mac'
            : /Windows/i.test(ua)
              ? 'Windows'
              : /Linux/i.test(ua)
                ? 'Linux'
                : ''
  const browser = /Edg\//i.test(ua)
    ? 'Edge'
    : /OPR\//i.test(ua)
      ? 'Opera'
      : /Firefox\//i.test(ua)
        ? 'Firefox'
        : /Chrome\//i.test(ua)
          ? 'Chrome'
          : /Safari\//i.test(ua)
            ? 'Safari'
            : ''
  return { device, browser }
}

/** 设备行标题：认得的拼成「Windows · Chrome」，两边都不认得就明说未知。 */
export function deviceLabel(value: string): string {
  const { device, browser } = parseUserAgent(value)
  if (device && browser) return device + ' · ' + browser
  if (device) return device + ' · 未知浏览器'
  if (browser) return '未知设备 · ' + browser
  return '未知设备'
}

/** IP 只露到网段：本机直接写「本机」，IPv4 抹掉最后一段，IPv6 只留前两组。 */
export function maskIp(value: string): string {
  const ip = String(value || '').trim()
  if (!ip) return '—'
  if (ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1' || ip === 'localhost') return '本机'
  if (ip.includes(':')) {
    const parts = ip.split(':').filter(Boolean)
    return parts.length >= 2 ? parts.slice(0, 2).join(':') + ':…' : ip
  }
  const v4 = ip.split('.')
  if (v4.length === 4) return v4.slice(0, 3).join('.') + '.*'
  return ip
}

/** 会话还有几天到期：向上取整，已过期记 0，不显示负数。 */
export function daysLeft(expiresAt: number, now: number = Date.now()): number {
  const ms = Number(expiresAt) - Number(now)
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.ceil(ms / 86400000)
}
