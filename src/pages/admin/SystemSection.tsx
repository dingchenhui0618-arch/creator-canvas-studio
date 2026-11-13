import { useState } from 'react'
import { request } from '../../api/client'
import { useUiMode } from '../../api/app'
import { formatDateTime, formatDuration, useApi, type BdcPort, type BdcStatus, type VersionInfo } from './data'
import SiteInfoCard from './SiteInfoCard'
import StorageGuard from './StorageGuard'
import WaterlineCard from './WaterlineCard'
import { AdminHead, Badge, ErrorBanner, LoadingLine, RefreshButton, SourceTag } from './ui'

type StorageItem = { name: string; bytes: number; files: number }
type StorageInfo = {
  ok: boolean
  dataDir: string
  bytes: number
  files: number
  items: StorageItem[]
  disk: { totalBytes: number; freeBytes: number } | null
  checkedAt: string
}

type DiagnosticsInfo = {
  ok: boolean
  mode: string
  generatedAt: string
  package: { name: string; version: string }
  process: {
    pid: number
    node: string
    platform: string
    startedAt: string
    uptimeSec: number
    memoryMb: { rss: number; heapUsed: number; heapTotal: number; external: number }
  }
  config: {
    dataDir: string
    uiMode: string
    models: { chat: string; chatFallbacks: string[]; vision: string; visionFallbacks: string[]; visionModels: string[] }
    upstream: {
      visionBaseUrl: string
      visionKeyConfigured: boolean
      searchKeyConfigured: boolean
      remoteWorker: boolean
      remoteWorkerLabel: string
    }
    auth: { requireAuth: boolean; registrationEnabled: boolean }
    limits: Record<string, number>
    webRead: { timeoutMs: number; maxBytes: number; maxChars: number }
    credits: { prices: Record<string, number>; concurrency: Record<string, number> }
  }
  tools: {
    list: { id: string; label: string; state: string }[]
    webRead: {
      enabled: boolean
      last: { at: string; ok: boolean; host: string; chars: number; ms: number; title: string; code: string } | null
    }
  }
  logs: {
    access: { at: string; id: string; m: string; p: string; s: number; ms: number; u: string; ip: string }[]
    errors: { at: string; id: string; msg: string; scope?: string; method?: string; path?: string }[]
    totals: { access: number; errors: number }
    limits: { access: number; errors: number }
  }
}

type AlertNotify = { at: string; ok: boolean; status: number; ms: number; error: string }

type AlertItem = {
  id: string
  kind: string
  level: string
  title: string
  detail: string
  count: number
  firstAt: string
  lastAt: string
  ackAt: string | null
  notify?: AlertNotify
}

type AlertChannel = {
  configured: boolean
  source: 'admin' | 'env' | 'none'
  urlMasked: string
  secretMasked: string
  signed: boolean
  enabled: boolean
  updatedAt: string
  updatedBy: string
  canEdit: boolean
  diskFreeMb: number
}

type OutboxStats = {
  pending: number
  dead: number
  total: number
  sentCount: number
  lastSentAt: string
  lastSentStatus: number
  lastAttempt: { at: string; status: number; attempts: number; error: string; state: string } | null
}

type OutboxItem = {
  id: string
  title: string
  kind: string
  attempts: number
  nextAt: string
  lastStatus: number
  lastError: string
  state: string
  createdAt: string
}

type AlertsInfo = {
  items: AlertItem[]
  counts: { open: number; total: number; byKind: Record<string, number> }
  disk: { ok: boolean; freeBytes: number; totalBytes: number; thresholdBytes: number }
  channel: AlertChannel
  outbox: OutboxStats
  outboxItems: OutboxItem[]
}

type MailChannel = {
  configured: boolean
  source: 'admin' | 'env' | 'none'
  host: string
  port: number
  secure: boolean
  starttls: boolean
  accountMasked: string
  hasPassword: boolean
  fromName: string
  fromAddress: string
  enabled: boolean
  updatedAt: string
  updatedBy: string
  canEdit: boolean
}

type MailInfo = {
  ok: boolean
  mail: MailChannel
  passwordReset: boolean
  ttlMinutes: number
}

// 复刻任务：以前任务只存内存，发版重启就 404、扣掉的积分也不退。
// 现在真源是 SQLite，后台能看到「这条停在哪一步、退没退」。
type JobItem = {
  id: string
  userEmail: string
  status: string
  step: string
  progress: number
  error: string | null
  templateId: string | null
  label: string
  cost: number
  refunded: boolean
  createdAt: string
}

type JobsInfo = {
  ok: boolean
  items: JobItem[]
  counts: Record<string, number>
}

const JOB_STATUS: Record<string, { label: string; tone: 'neutral' | 'ok' | 'warn' | 'fail' }> = {
  queued: { label: '排队中', tone: 'neutral' },
  running: { label: '进行中', tone: 'neutral' },
  done: { label: '已完成', tone: 'ok' },
  error: { label: '失败', tone: 'fail' },
}

// 「失败」和「中断」分开：前者是链接/素材问题，后者是服务重启——两者的下一步动作不一样
function jobStatusOf(item: JobItem) {
  if (item.status === 'error' && /重启|中断/.test(item.error || '')) return { label: '已中断', tone: 'fail' as const }
  return JOB_STATUS[item.status] || { label: item.status, tone: 'neutral' as const }
}

const JOB_STEP: Record<string, string> = {
  queued: '等待开始',
  resolve: '解析链接',
  remote: '远端算力',
  probe: '读视频信息',
  scene: '检测镜头',
  frames: '抽帧',
  vision: '逐帧分析',
  save: '写入模板库',
  done: '完成',
}


// 数据备份（v0.9.49）：备份是 systemd 独立进程，服务挂了也要能跑。
// 后台只读状态文件：上一次成不成、是不是加密、恢复演练过没过、有没有异地副本。
type BackupVerify = {
  ok: boolean
  ms: number
  integrityCheck: string
  users: number | null
  templates: number | null
  keys: number | null
  keyDecrypt: string
  errors: string[]
}

type BackupStatus = {
  at: string
  ok: boolean
  file: string
  bytes: number
  sha256: string
  encrypted: boolean
  passphraseFingerprint: string
  format: number
  durationMs: number
  kept: number
  errors: string[]
  verify: BackupVerify | null
  offsite: { ok: boolean; dir: string; bytes: number; sha256: string; error: string } | null
  previousOkAt: string | null
}

type BackupArchive = { name: string; bytes: number; mtime: string; encrypted: boolean }

type BackupsInfo = {
  ok: boolean
  status: BackupStatus | null
  dir: string
  keep: number
  offsiteConfigured: boolean
  items: BackupArchive[]
  counts: { total: number; encrypted: number; plaintext: number; bytes: number }
}

const KEY_DECRYPT_LABEL: Record<string, string> = {
  ok: '可解密',
  empty: 'Key 池为空',
  none: '没有 Key 文件',
  'empty-plaintext': '解出来是空',
  failed: '解不开',
}

type ClientErrorItem = {
  id: string
  at: string
  lastAt: string
  count: number
  kind: string
  message: string
  stack: string
  page: string
  version: string
}

type ClientErrorsInfo = {
  items: ClientErrorItem[]
  total: number
  last24h: number
  limits: { cap: number; dedupeMin: number }
}

type LogFile = { name: string; kind: string; day: string; bytes: number; mtime: string }

type LogsInfo = {
  dir: string
  retentionDays: number
  maxTotalMb: number
  totalFiles: number
  totalBytes: number
  oldestDay: string
  newestDay: string
  files: LogFile[]
}

const LOG_KIND_LABEL: Record<string, string> = {
  access: '访问',
  error: '错误',
  app: '事件',
}

const CLIENT_ERROR_KIND: Record<string, string> = {
  error: '脚本错误',
  unhandledrejection: '未处理 Promise',
  react: '页面渲染',
  resource: '资源加载',
}

const ALERT_KIND_LABEL: Record<string, string> = {
  'server-5xx': '服务端 5xx',
  'model-blocked': '模型上游失败',
  'disk-low': '磁盘不足',
  memory: '内存水位',
  test: '测试',
}

// 后台只需要「大概多大」，用十进制单位；少于 1 KB 也写清楚，不显示 0 B 之外的奇怪精度。
function formatBytes(value?: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
  if (value < 1024) return value + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return size.toFixed(size >= 10 ? 0 : 1) + ' ' + units[index]
}

function PortRow({ name, port, internal }: { name: string; port: BdcPort; internal: boolean }) {
  // 生产环境只给结论：回调地址、内网端口属于排障信息，留在内部环境
  const showUrl = internal || !/127\.0\.0\.1|localhost|\[::1\]/.test(port.url || '')
  return (
    <div className="admin-port">
      <span className="admin-port-name">{name}</span>
      <span className="admin-mono">{showUrl ? port.url || '—' : '内网地址'}</span>
      <Badge tone={port.up ? 'ok' : 'warn'}>{port.up ? '在线' : '未部署'}</Badge>
      <span className="admin-cell-sub">{port.up ? (internal ? `HTTP ${port.status}` : '可访问') : internal ? port.error || '无响应' : '不可用'}</span>
    </div>
  )
}

export default function SystemSection() {
  const { internal } = useUiMode()
  const version = useApi<VersionInfo>('/api/version')
  const bdc = useApi<BdcStatus>('/api/bdc/status')
  const storage = useApi<StorageInfo>('/api/admin/storage')
  const alerts = useApi<AlertsInfo>('/api/admin/alerts')
  const jobs = useApi<JobsInfo>('/api/admin/jobs')
  const backups = useApi<BackupsInfo>('/api/admin/backups')
  const mail = useApi<MailInfo>('/api/admin/mail')
  const [alertNote, setAlertNote] = useState('')
  const [busy, setBusy] = useState('')
  // 外推通道：地址本身是凭证，输入框不预填；保存后接口只回掩码
  const [channelUrl, setChannelUrl] = useState('')
  const [channelNote, setChannelNote] = useState('')
  const [channelSecret, setChannelSecret] = useState('')
  const [channelBusy, setChannelBusy] = useState('')
  // 邮件通道：口令只写不读，输入框永远是空的；保存时留空 = 沿用旧口令
  const [mailBusy, setMailBusy] = useState('')
  const [mailNote, setMailNote] = useState('')
  const [testTo, setTestTo] = useState('')
  const [mailForm, setMailForm] = useState({
    host: '',
    port: '587',
    secure: false,
    user: '',
    pass: '',
    fromName: 'VisionQA',
    fromAddress: '',
  })

  const errors = [
    version.error ? `GET /api/version：${version.error}` : '',
    bdc.error ? `GET /api/bdc/status：${bdc.error}` : '',
    storage.error ? `GET /api/admin/storage：${storage.error}` : '',
    alerts.error ? `GET /api/admin/alerts：${alerts.error}` : '',
    jobs.error ? `GET /api/admin/jobs：${jobs.error}` : '',
    mail.error ? `GET /api/admin/mail：${mail.error}` : '',
  ].filter(Boolean)

  const reload = () => {
    version.reload()
    bdc.reload()
    storage.reload()
    alerts.reload()
    jobs.reload()
    mail.reload()
  }

  // 测试告警会真的记一条，并等这一次外推的结果回来——只写「已发送」等于没验
  const sendTestAlert = async () => {
    setBusy('test')
    setAlertNote('')
    try {
      const result = await request<{ notify: AlertNotify | null }>('/api/admin/alerts/test', { method: 'POST', body: JSON.stringify({}) })
      const notify = result.notify
      setAlertNote(
        !notify
          ? '已记一条测试告警：现在没有外推通道，只留在本站队列'
          : notify.ok
            ? '已记一条测试告警，外推成功（HTTP ' + notify.status + '，' + notify.ms + ' ms）'
            : '已记一条测试告警，但外推失败（' + (notify.status || '连不上') + '）：' + (notify.error || '接收端没接受') + '；已进重试队列',
      )
      alerts.reload()
    } catch (cause) {
      setAlertNote(cause instanceof Error ? cause.message : '发送失败')
    } finally {
      setBusy('')
    }
  }

  const saveAlertChannel = async () => {
    setChannelBusy('save')
    setChannelNote('')
    setChannelSecret('')
    try {
      const result = await request<{ channel: AlertChannel; secret: string }>('/api/admin/alerts/channel', {
        method: 'PUT',
        body: JSON.stringify({ url: channelUrl.trim(), enabled: true }),
      })
      setChannelUrl('')
      setChannelSecret(result.secret || '')
      setChannelNote(result.secret ? '通道已保存。签名密钥只显示这一次，请现在填到接收端。' : '通道已保存，签名密钥沿用旧的。')
      alerts.reload()
    } catch (cause) {
      setChannelNote(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      setChannelBusy('')
    }
  }

  const clearAlertChannel = async () => {
    setChannelBusy('clear')
    setChannelNote('')
    setChannelSecret('')
    try {
      await request('/api/admin/alerts/channel', { method: 'DELETE' })
      setChannelNote('已清掉后台配置的通道；如果环境变量里有 VQ_ALERT_WEBHOOK，会继续用它。')
      alerts.reload()
    } catch (cause) {
      setChannelNote(cause instanceof Error ? cause.message : '清除失败')
    } finally {
      setChannelBusy('')
    }
  }

  const retryOutbox = async (item: OutboxItem) => {
    setChannelBusy(item.id)
    setChannelNote('')
    try {
      const result = await request<{ item: OutboxItem }>('/api/admin/alerts/outbox/' + item.id + '/retry', {
        method: 'POST',
        body: JSON.stringify({}),
      })
      setChannelNote(result.item.state === 'sent' ? '这条已经补发成功，队列里不再留。' : '这次还是没发出去，已按退避时间再排一次。')
      alerts.reload()
    } catch (cause) {
      setChannelNote(cause instanceof Error ? cause.message : '重试失败')
    } finally {
      setChannelBusy('')
    }
  }

  const saveMailChannel = async () => {
    setMailBusy('save')
    setMailNote('')
    try {
      const result = await request<{ mail: MailChannel; passKept: boolean }>('/api/admin/mail/channel', {
        method: 'PUT',
        body: JSON.stringify({
          host: mailForm.host.trim(),
          port: Number(mailForm.port) || 0,
          secure: mailForm.secure,
          user: mailForm.user.trim(),
          pass: mailForm.pass,
          fromName: mailForm.fromName.trim(),
          fromAddress: mailForm.fromAddress.trim(),
        }),
      })
      setMailForm((previous) => ({ ...previous, pass: '' }))
      setMailNote(
        result.passKept
          ? '邮件通道已保存，口令沿用之前那条。'
          : '邮件通道已保存。现在可以发一封测试邮件，确认收件端能收到。',
      )
      mail.reload()
    } catch (cause) {
      setMailNote(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      setMailBusy('')
    }
  }

  const clearMailChannel = async () => {
    setMailBusy('clear')
    setMailNote('')
    try {
      await request('/api/admin/mail/channel', { method: 'DELETE' })
      setMailNote('已清掉后台配置的邮件通道。登录页的「忘记密码」会退回「找管理员」的提示。')
      mail.reload()
    } catch (cause) {
      setMailNote(cause instanceof Error ? cause.message : '清除失败')
    } finally {
      setMailBusy('')
    }
  }

  const sendTestMail = async () => {
    setMailBusy('test')
    setMailNote('')
    try {
      const result = await request<{ ok: boolean; ms: number; to: string }>('/api/admin/mail/test', {
        method: 'POST',
        body: JSON.stringify({ to: testTo.trim() }),
      })
      setMailNote('测试邮件已交给发信服务器（' + result.ms + ' ms，收件 ' + result.to + '）。去收件箱确认一下。')
    } catch (cause) {
      setMailNote(cause instanceof Error ? cause.message : '发测试邮件失败')
    } finally {
      setMailBusy('')
    }
  }

  const ack = async (item: AlertItem) => {
    setBusy(item.id)
    setAlertNote('')
    try {
      await request('/api/admin/alerts/' + item.id + '/ack', { method: 'POST', body: JSON.stringify({}) })
      alerts.reload()
    } catch (cause) {
      setAlertNote(cause instanceof Error ? cause.message : '确认失败')
    } finally {
      setBusy('')
    }
  }

  return (
    <>
      <AdminHead
        kicker="ADMIN / SYSTEM"
        title="系统与版本"
        description={
          internal
            ? '版本、VisionQA Canvas 三端口与数据目录说明。所有状态来自真实接口；未部署就如实写未部署。'
            : '版本、画布服务状态与数据占用；没有数据的地方写空状态，不估算、不编造。'
        }
        actions={<RefreshButton onClick={reload} busy={version.loading || bdc.loading || storage.loading} />}
      />

      {errors.length ? <ErrorBanner message={errors.join('；')} onRetry={reload} /> : null}

      <section className="admin-card admin-block">
        <div className="admin-block-head">
          <div>
            <p className="admin-label">告警</p>
            <p className="admin-sub">
              5xx、模型上游失败、磁盘剩余不足三类会落到这里：同一条 30 分钟内只累加次数；服务重启后仍然在，不靠人盯日志。
              外推通道可以在下面直接配，推失败会进重试队列。
            </p>
          </div>
          <div className="admin-alert-actions">
            <SourceTag kind="api" source="GET /api/admin/alerts" />
            <button type="button" className="vq-button vq-button--ghost" onClick={() => void sendTestAlert()} disabled={busy === 'test'}>
              {busy === 'test' ? '发送中…' : '发一条测试告警'}
            </button>
          </div>
        </div>

        {alerts.loading && !alerts.data ? <LoadingLine label="/api/admin/alerts" /> : null}

        {alerts.data ? (
          <>
            <div className="admin-alert-facts">
              <span>
                <b>{alerts.data.counts.open}</b> 未确认
              </span>
              <span>
                <b>{alerts.data.counts.total}</b> 历史累计
              </span>
              <span>
                磁盘剩余 <b>{formatBytes(alerts.data.disk.freeBytes)}</b>，阈值 {formatBytes(alerts.data.disk.thresholdBytes)}
              </span>
              <span>
                外推通道 <b>{alerts.data.channel.configured ? '已配置' : '未配置'}</b>
              </span>
            </div>

            {/* 外推通道：地址本身是凭证，页面只给掩码；保存后换了一把签名密钥才回明文 */}
            <div className="admin-channel">
              <div className="admin-channel-head">
                <div>
                  <p className="admin-label">外推通道</p>
                  <p className="admin-sub">
                    机器人或自建接收端都行，POST 一条 JSON：<code className="admin-mono">{'{ text, alert, source }'}</code>。
                    配了签名就带 <code className="admin-mono">x-vq-signature: sha256=…</code>（HMAC-SHA256，对请求体原文）。
                    推失败不会丢：按 1 / 5 / 15 分钟重试，四次都不成才标「已失败」。
                  </p>
                </div>
                <Badge tone={alerts.data.channel.configured ? 'ok' : 'warn'}>
                  {alerts.data.channel.configured ? '已配置' : '未配置'}
                </Badge>
              </div>

              <dl className="admin-kv">
                <div>
                  <dt>接收地址</dt>
                  <dd>
                    <code className="admin-mono">{alerts.data.channel.urlMasked || '—'}</code>
                    {alerts.data.channel.source === 'env' ? <span className="admin-cell-sub">来自环境变量 VQ_ALERT_WEBHOOK</span> : null}
                    {alerts.data.channel.source === 'admin' ? <span className="admin-cell-sub">后台配置{alerts.data.channel.updatedBy ? ' · ' + alerts.data.channel.updatedBy : ''}</span> : null}
                  </dd>
                </div>
                <div>
                  <dt>签名</dt>
                  <dd>
                    <Badge tone={alerts.data.channel.signed ? 'ok' : 'neutral'}>{alerts.data.channel.signed ? '已开启' : '未开启'}</Badge>
                    <code className="admin-mono">{alerts.data.channel.secretMasked || '—'}</code>
                  </dd>
                </div>
                <div>
                  <dt>投递</dt>
                  <dd>
                    成功 {alerts.data.outbox.sentCount} 次
                    {alerts.data.outbox.lastSentAt ? ' · 最近 ' + formatDateTime(alerts.data.outbox.lastSentAt) + '（HTTP ' + alerts.data.outbox.lastSentStatus + '）' : ''}
                    {' · '}待重试 {alerts.data.outbox.pending} · 已失败 {alerts.data.outbox.dead}
                  </dd>
                </div>
                {alerts.data.outbox.lastAttempt ? (
                  <div>
                    <dt>最近一次尝试</dt>
                    <dd>
                      <Badge tone={alerts.data.outbox.lastAttempt.state === 'dead' ? 'fail' : alerts.data.outbox.lastAttempt.state === 'pending' ? 'warn' : 'ok'}>
                        {alerts.data.outbox.lastAttempt.state === 'dead' ? '已失败' : alerts.data.outbox.lastAttempt.state === 'pending' ? '等重试' : '已发出'}
                      </Badge>
                      <span className="admin-cell-sub">
                        第 {alerts.data.outbox.lastAttempt.attempts} 次 · {alerts.data.outbox.lastAttempt.status ? 'HTTP ' + alerts.data.outbox.lastAttempt.status : '连不上'}
                        {alerts.data.outbox.lastAttempt.error ? ' · ' + alerts.data.outbox.lastAttempt.error : ''}
                      </span>
                    </dd>
                  </div>
                ) : null}
              </dl>

              {alerts.data.channel.canEdit ? (
                <div className="admin-channel-form">
                  <label className="vq-field admin-channel-field">
                    <span>机器人 / webhook 地址</span>
                    <input
                      className="vq-input"
                      value={channelUrl}
                      onChange={(event) => setChannelUrl(event.target.value)}
                      placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={channelBusy === 'save'}
                    />
                  </label>
                  <div className="admin-doc-actions">
                    <button
                      type="button"
                      className="vq-button"
                      onClick={() => void saveAlertChannel()}
                      disabled={channelBusy === 'save' || !channelUrl.trim()}
                    >
                      {channelBusy === 'save' ? '保存中…' : '保存通道'}
                    </button>
                    {alerts.data.channel.source === 'admin' ? (
                      <button type="button" className="vq-button vq-button--ghost" onClick={() => void clearAlertChannel()} disabled={channelBusy === 'clear'}>
                        {channelBusy === 'clear' ? '清除中…' : '清掉通道'}
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {alerts.data.channel.source === 'env' ? (
                <p className="admin-hint">现在用的是服务器环境变量 VQ_ALERT_WEBHOOK。要换地址可以先在上面保存一条，后台配置优先于环境变量。</p>
              ) : null}

              {channelSecret ? (
                <p className="admin-hint admin-hint--ok">
                  签名密钥（只显示这一次）：<code className="admin-mono">{channelSecret}</code>
                </p>
              ) : null}
              {channelNote ? <p className="admin-hint">{channelNote}</p> : null}
            </div>

            {alerts.data.items.length ? (
              <ul className="admin-alert-list">
                {alerts.data.items.map((item) => (
                  <li key={item.id} className="admin-alert-row">
                    <Badge tone={item.kind === 'test' ? 'neutral' : item.level === 'warn' ? 'warn' : 'fail'}>
                      {ALERT_KIND_LABEL[item.kind] || item.kind}
                    </Badge>
                    <div className="admin-alert-copy">
                      <strong>{item.title}</strong>
                      <span className="admin-cell-sub admin-mono">
                        第 {item.count} 次 · 最近 {formatDateTime(item.lastAt)}
                        {item.detail ? ' · ' + item.detail : ''}
                        {item.notify
                          ? ' · 外推' + (item.notify.ok ? ' HTTP ' + item.notify.status + '（' + item.notify.ms + ' ms）' : '失败（' + (item.notify.status || '连不上') + '）')
                          : ''}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="vq-button vq-button--ghost vq-button--icon"
                      onClick={() => void ack(item)}
                      disabled={busy === item.id}
                    >
                      {busy === item.id ? '确认中…' : '确认'}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="admin-hint admin-hint--ok">没有未确认的告警：5xx、上游失败与磁盘水位都正常。</p>
            )}

            {alerts.data.outboxItems.length ? (
              <div className="admin-block">
                <p className="admin-label">没推出去的通知</p>
                <p className="admin-sub">接收端自己也会挂，所以失败不丢：按 1 / 5 / 15 分钟退避重试，四次都不成才标「已失败」。</p>
                <ul className="admin-alert-list">
                  {alerts.data.outboxItems.map((item) => (
                    <li key={item.id} className="admin-alert-row">
                      <Badge tone={item.state === 'dead' ? 'fail' : 'warn'}>{item.state === 'dead' ? '已失败' : '等重试'}</Badge>
                      <div className="admin-alert-copy">
                        <strong>{item.title}</strong>
                        <span className="admin-cell-sub admin-mono">
                          第 {item.attempts} 次 ·{' '}
                          {item.state === 'dead' ? '不再自动重试' : '下次 ' + formatDateTime(item.nextAt)} ·{' '}
                          {item.lastStatus ? 'HTTP ' + item.lastStatus : '连不上'}
                          {item.lastError ? ' · ' + item.lastError : ''}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="vq-button vq-button--ghost vq-button--icon"
                        onClick={() => void retryOutbox(item)}
                        disabled={channelBusy === item.id}
                      >
                        {channelBusy === item.id ? '重试中…' : '重试'}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : null}

        {alertNote ? <p className="admin-hint">{alertNote}</p> : null}
      </section>

      <section className="admin-card admin-block">
        <div className="admin-block-head">
          <div>
            <p className="admin-label">邮件通道</p>
            <p className="admin-sub">
              找回密码靠它发信：登录页点「忘记密码」→ 服务端发一封 30 分钟有效的一次性链接 → 改完注销这个账号的全部会话。
              口令只写不读；没配通道时登录页不提供自助找回，只提示找管理员。
            </p>
          </div>
          <div className="admin-alert-actions">
            <SourceTag kind="api" source="GET /api/admin/mail" />
            <button
              type="button"
              className="vq-button vq-button--ghost"
              onClick={() => void sendTestMail()}
              disabled={mailBusy === 'test' || !mail.data?.mail.configured}
            >
              {mailBusy === 'test' ? '发送中…' : '发一封测试邮件'}
            </button>
          </div>
        </div>

        {mail.loading && !mail.data ? <LoadingLine label="/api/admin/mail" /> : null}

        {mail.data ? (
          <>
            <div className="admin-alert-facts">
              <span>
                通道 <b>{mail.data.mail.configured ? '已配置' : '未配置'}</b>
              </span>
              <span>
                登录页「忘记密码」<b>{mail.data.passwordReset ? '可用' : '不可用'}</b>
              </span>
              <span>
                链接有效期 <b>{mail.data.ttlMinutes}</b> 分钟
              </span>
              <span>
                发信服务器 <b className="admin-mono">{mail.data.mail.host ? mail.data.mail.host + ':' + mail.data.mail.port : '—'}</b>
              </span>
            </div>

            <div className="admin-channel">
              <div className="admin-channel-head">
                <div>
                  <p className="admin-label">发信服务</p>
                  <p className="admin-sub">
                    465 走直连 TLS，587 走 STARTTLS；账号与口令是 SMTP 登录用的，不是站点账号。发件地址会出现在收件人的邮箱里。
                  </p>
                </div>
                <Badge tone={mail.data.mail.configured ? 'ok' : 'warn'}>{mail.data.mail.configured ? '能发信' : '未配置'}</Badge>
              </div>

              <dl className="admin-kv">
                <div>
                  <dt>服务器</dt>
                  <dd>
                    <code className="admin-mono">{mail.data.mail.host ? mail.data.mail.host + ':' + mail.data.mail.port : '—'}</code>
                    {mail.data.mail.source === 'env' ? <span className="admin-cell-sub">来自环境变量 VQ_SMTP_*</span> : null}
                    {mail.data.mail.source === 'admin' ? (
                      <span className="admin-cell-sub">后台配置{mail.data.mail.updatedBy ? ' · ' + mail.data.mail.updatedBy : ''}</span>
                    ) : null}
                  </dd>
                </div>
                <div>
                  <dt>加密</dt>
                  <dd>{mail.data.mail.secure ? '直连 TLS' : mail.data.mail.starttls ? 'STARTTLS' : '明文（只建议本机测试）'}</dd>
                </div>
                <div>
                  <dt>账号</dt>
                  <dd>
                    <code className="admin-mono">{mail.data.mail.accountMasked || '不需要认证'}</code>
                    <Badge tone={mail.data.mail.hasPassword ? 'ok' : 'neutral'}>{mail.data.mail.hasPassword ? '口令已保存' : '无口令'}</Badge>
                  </dd>
                </div>
                <div>
                  <dt>发件人</dt>
                  <dd>
                    <code className="admin-mono">{mail.data.mail.fromAddress || '—'}</code>
                    {mail.data.mail.fromName ? <span className="admin-cell-sub">{mail.data.mail.fromName}</span> : null}
                  </dd>
                </div>
                <div>
                  <dt>测试收件</dt>
                  <dd>
                    <input
                      className="vq-input"
                      value={testTo}
                      onChange={(event) => setTestTo(event.target.value)}
                      placeholder="留空发到自己的管理员邮箱"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={mailBusy === 'test'}
                    />
                  </dd>
                </div>
              </dl>

              {mail.data.mail.canEdit ? (
                <div className="admin-mail-form">
                  <label className="vq-field admin-mail-field">
                    <span>服务器</span>
                    <input
                      className="vq-input"
                      value={mailForm.host}
                      onChange={(event) => setMailForm((previous) => ({ ...previous, host: event.target.value }))}
                      placeholder="smtp.example.com"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={mailBusy === 'save'}
                    />
                  </label>
                  <label className="vq-field admin-mail-field--port">
                    <span>端口</span>
                    <input
                      className="vq-input"
                      value={mailForm.port}
                      onChange={(event) => setMailForm((previous) => ({ ...previous, port: event.target.value }))}
                      inputMode="numeric"
                      disabled={mailBusy === 'save'}
                    />
                  </label>
                  <label className="vq-check admin-mail-field--check">
                    <input
                      type="checkbox"
                      checked={mailForm.secure}
                      onChange={(event) => setMailForm((previous) => ({ ...previous, secure: event.target.checked }))}
                      disabled={mailBusy === 'save'}
                    />
                    <span>直连 TLS</span>
                  </label>
                  <label className="vq-field admin-mail-field">
                    <span>账号</span>
                    <input
                      className="vq-input"
                      value={mailForm.user}
                      onChange={(event) => setMailForm((previous) => ({ ...previous, user: event.target.value }))}
                      placeholder="不需要认证就留空"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={mailBusy === 'save'}
                    />
                  </label>
                  <label className="vq-field admin-mail-field">
                    <span>口令</span>
                    <input
                      className="vq-input"
                      type="password"
                      value={mailForm.pass}
                      onChange={(event) => setMailForm((previous) => ({ ...previous, pass: event.target.value }))}
                      placeholder={mail.data.mail.hasPassword ? '留空沿用已保存的口令' : 'SMTP 口令'}
                      autoComplete="new-password"
                      disabled={mailBusy === 'save'}
                    />
                  </label>
                  <label className="vq-field admin-mail-field">
                    <span>发件地址</span>
                    <input
                      className="vq-input"
                      value={mailForm.fromAddress}
                      onChange={(event) => setMailForm((previous) => ({ ...previous, fromAddress: event.target.value }))}
                      placeholder="发件邮箱（收件人看到的那个）"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={mailBusy === 'save'}
                    />
                  </label>
                  <label className="vq-field admin-mail-field">
                    <span>发件人名</span>
                    <input
                      className="vq-input"
                      value={mailForm.fromName}
                      onChange={(event) => setMailForm((previous) => ({ ...previous, fromName: event.target.value }))}
                      disabled={mailBusy === 'save'}
                    />
                  </label>
                  <div className="admin-doc-actions">
                    <button
                      type="button"
                      className="vq-button"
                      onClick={() => void saveMailChannel()}
                      disabled={mailBusy === 'save' || !mailForm.host.trim() || !mailForm.fromAddress.trim()}
                    >
                      {mailBusy === 'save' ? '保存中…' : '保存通道'}
                    </button>
                    {mail.data.mail.source === 'admin' ? (
                      <button
                        type="button"
                        className="vq-button vq-button--ghost"
                        onClick={() => void clearMailChannel()}
                        disabled={mailBusy === 'clear'}
                      >
                        {mailBusy === 'clear' ? '清除中…' : '清掉通道'}
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {mail.data.mail.source === 'env' ? (
                <p className="admin-hint">现在用的是服务器环境变量 VQ_SMTP_*。在上面保存一条会覆盖它；清掉后台配置后又会回到环境变量。</p>
              ) : null}
              {mailNote ? <p className="admin-hint">{mailNote}</p> : null}
            </div>
          </>
        ) : null}
      </section>

      <SiteInfoCard />

      <section className="admin-card admin-block">
        <div className="admin-block-head">
          <div>
            <p className="admin-label">复刻任务</p>
            <p className="admin-sub">
              任务的每一步都落在库里，发版重启后历史还在。上次没跑完的任务会被标成「已中断」，并按积分账本把净扣款退回——同一笔只退一次。
            </p>
          </div>
          <SourceTag kind="api" source="GET /api/admin/jobs" />
        </div>

        {jobs.loading && !jobs.data ? <LoadingLine label="/api/admin/jobs" /> : null}

        {jobs.data ? (
          <>
            <div className="admin-alert-facts">
              <span>
                <b>{(jobs.data.counts.running || 0) + (jobs.data.counts.queued || 0)}</b> 进行中
              </span>
              <span>
                <b>{jobs.data.counts.done || 0}</b> 已完成
              </span>
              <span>
                <b>{jobs.data.counts.error || 0}</b> 失败或中断
              </span>
              <span>
                已退款 <b>{jobs.data.items.filter((item) => item.refunded).reduce((sum, item) => sum + item.cost, 0)}</b> 积分
              </span>
            </div>

            {jobs.data.items.length ? (
              // 用列表而不是表格：一条任务有「说明 + 账号 + 扣退」三段长文本，
              // 表格在 390 宽只能横向滚，列表会自己换行（与上面「告警」同一套行样式）。
              <ul className="admin-alert-list">
                {jobs.data.items.map((item) => {
                  const status = jobStatusOf(item)
                  return (
                    <li key={item.id} className="admin-alert-row admin-job-row">
                      <div className="admin-alert-copy">
                        <span className="admin-job-head">
                          <Badge tone={status.tone}>{status.label}</Badge>
                          <strong>{item.label || '复刻任务'}</strong>
                        </span>
                        <span className="admin-cell-sub admin-mono">
                          {formatDateTime(item.createdAt)} · {item.userEmail || '未登录'} · 停在 {JOB_STEP[item.step] || item.step} ·{' '}
                          {item.progress}% · {item.cost ? item.cost + ' 积分' + (item.refunded ? '（已退回）' : '') : '不计费'}
                        </span>
                        <span className="admin-cell-sub">
                          {item.templateId ? '已入库 ' + item.templateId : item.error || (item.status === 'done' ? '完成' : '进行中')}
                        </span>
                      </div>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="admin-hint">还没有复刻任务：从「发现」里选一条内容、或在雷达页粘贴视频直链发起复刻，这里会出现任务进度与扣退记录。</p>
            )}
          </>
        ) : null}
      </section>

      <section className="admin-card admin-block">
        <div className="admin-block-head">
          <div>
            <p className="admin-label">数据备份</p>
            <p className="admin-sub">
              每天由系统定时任务导出一次：库用 SQLite 自己的快照、归档整体加密、写完立刻做一次恢复演练。备份是独立进程，服务挂了也照样跑。
            </p>
          </div>
          <SourceTag kind="api" source="GET /api/admin/backups" />
        </div>

        {backups.loading && !backups.data ? <LoadingLine label="/api/admin/backups" /> : null}

        {backups.data ? (
          <>
            <div className="admin-alert-facts">
              <span>
                最近备份{' '}
                <b>{backups.data.status ? formatDateTime(backups.data.status.at) : '还没有跑过'}</b>
              </span>
              <span>
                大小 <b>{backups.data.status ? formatBytes(backups.data.status.bytes) : '—'}</b>
                {backups.data.status ? ' · 耗时 ' + formatDuration(backups.data.status.durationMs) : ''}
              </span>
              <span>
                加密 <b>{backups.data.status ? (backups.data.status.encrypted ? '已加密' : '未加密') : '—'}</b>
                {backups.data.status?.encrypted && backups.data.status.passphraseFingerprint
                  ? ' · 口令指纹 ' + backups.data.status.passphraseFingerprint
                  : ''}
              </span>
              <span>
                恢复演练{' '}
                <b>{backups.data.status?.verify ? (backups.data.status.verify.ok ? '通过' : '失败') : '—'}</b>
                {backups.data.status?.verify?.ok
                  ? ' · 账号 ' + (backups.data.status.verify.users ?? '—') + ' / 模板 ' + (backups.data.status.verify.templates ?? '—') + ' / Key ' + (KEY_DECRYPT_LABEL[backups.data.status.verify.keyDecrypt] || backups.data.status.verify.keyDecrypt)
                  : ''}
              </span>
              <span>
                异地副本{' '}
                <b>
                  {backups.data.status?.offsite
                    ? backups.data.status.offsite.ok
                      ? '已写入'
                      : '失败'
                    : backups.data.offsiteConfigured
                      ? '已配置未写入'
                      : '未配置'}
                </b>
                {backups.data.status?.offsite?.ok ? ' · ' + backups.data.status.offsite.dir : ''}
              </span>
              <span>
                在盘 <b>{backups.data.counts.total}</b> 份 · 保留 {backups.data.keep}
              </span>
            </div>

            {backups.data.status && !backups.data.status.ok && backups.data.status.errors.length ? (
              <p className="admin-hint admin-hint--fail">
                上一次备份没过：{backups.data.status.errors.join('；')}
              </p>
            ) : null}

            {backups.data.items.length ? (
              // 与复刻任务同一套行样式：标题 + 一串等宽元信息，390 宽只换行不横向滚。
              <ul className="admin-alert-list">
                {backups.data.items.map((item) => (
                  <li key={item.name} className="admin-alert-row admin-backup-row">
                    <div className="admin-alert-copy">
                      <span className="admin-job-head">
                        <Badge tone={item.encrypted ? 'ok' : 'warn'}>{item.encrypted ? '已加密' : '明文'}</Badge>
                        <strong className="admin-mono">{item.name}</strong>
                      </span>
                      <span className="admin-cell-sub admin-mono">
                        {formatBytes(item.bytes)} · {formatDateTime(item.mtime)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="admin-hint">还没有备份归档：定时任务跑过一次后，这里会出现每一份的大小、时间与是否加密。</p>
            )}

            <p className="admin-hint admin-mono">备份目录 {backups.data.dir}</p>
          </>
        ) : null}
      </section>

      <ClientErrorsCard />

      <div className="admin-grid admin-grid--two">
        <section className="admin-card admin-block">
          <div className="admin-block-head">
            <div>
              <p className="admin-label">当前版本</p>
              <p className="admin-sub">{internal ? '来自服务端读取的 package.json 与启动时间。' : '当前部署的版本与启动时间。'}</p>
            </div>
            <SourceTag kind="api" source="GET /api/version" />
          </div>
          {version.loading && !version.data ? <LoadingLine label="/api/version" /> : null}
          {version.data ? (
            <dl className="admin-kv">
              <div>
                <dt>版本</dt>
                <dd>
                  <span className="admin-value admin-value--inline">v{version.data.version}</span>
                </dd>
              </div>
              {version.data.runtime ? (
                <div>
                  <dt>运行环境</dt>
                  <dd>
                    <code className="admin-mono">Node {version.data.runtime.node}</code>
                    <Badge tone={version.data.runtime.level === 'supported' ? 'ok' : version.data.runtime.level === 'untested' ? 'warn' : 'fail'}>
                      {version.data.runtime.level === 'supported' ? '已验证' : version.data.runtime.level === 'untested' ? '未验证' : '不支持'}
                    </Badge>
                    <span className="admin-cell-sub">支持 {version.data.runtime.min} 起；生产与 CI 都按这个范围跑</span>
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>服务名</dt>
                <dd className={internal ? 'admin-mono' : ''}>{internal ? version.data.name : 'VisionQA 工作台'}</dd>
              </div>
              <div>
                <dt>启动时间</dt>
                <dd className="admin-mono">{formatDateTime(version.data.startedAt)}</dd>
              </div>
            </dl>
          ) : null}
        </section>

        <section className="admin-card admin-block">
          <div className="admin-block-head">
            <div>
              <p className="admin-label">VisionQA Canvas</p>
              <p className="admin-sub">{internal ? '三端口状态，不启动、不探测额外地址。' : '画布服务的运行状态与访问地址。'}</p>
            </div>
            <SourceTag kind="api" source="GET /api/bdc/status" />
          </div>
          {bdc.loading && !bdc.data ? <LoadingLine label="/api/bdc/status" /> : null}
          {bdc.data ? (
            <>
              <p className="admin-deploy-line">
                <Badge tone={bdc.data.deployed ? 'ok' : 'warn'}>
                  {bdc.data.deployed ? '已部署' : '未部署'}
                </Badge>
                {internal ? <span>deployed = {String(bdc.data.deployed)}</span> : null}
              </p>
              <div className="admin-ports">
                <PortRow name="Web" port={bdc.data.web} internal={internal} />
                <PortRow name="Admin" port={bdc.data.admin} internal={internal} />
                <PortRow name="API" port={bdc.data.api} internal={internal} />
              </div>
            </>
          ) : null}
        </section>
      </div>

      <section className="admin-card admin-block">
        <div className="admin-block-head">
          <div>
            <p className="admin-label">数据存储</p>
            <p className="admin-sub">
              {internal ? '真实统计 data 目录的文件与占用；磁盘余量来自操作系统，不在前端估算。' : '模板、运行记录与账号数据的实际占用；换机器或备份前先看这里。'}
            </p>
          </div>
          <SourceTag kind="api" source="GET /api/admin/storage" />
        </div>

        {storage.loading && !storage.data ? <LoadingLine label="/api/admin/storage" /> : null}

        {storage.data ? (
          <>
            <dl className="admin-kv">
              <div>
                <dt>总占用</dt>
                <dd>
                  <span className="admin-value admin-value--inline">{formatBytes(storage.data.bytes)}</span>
                  <span className="admin-cell-sub">共 {storage.data.files} 个文件</span>
                </dd>
              </div>
              {storage.data.disk ? (
                <div>
                  <dt>磁盘余量</dt>
                  <dd>
                    <span className="admin-mono">{formatBytes(storage.data.disk.freeBytes)}</span>
                    <span className="admin-cell-sub">可用 / 共 {formatBytes(storage.data.disk.totalBytes)}</span>
                  </dd>
                </div>
              ) : null}
              {internal ? (
                <div>
                  <dt>数据目录</dt>
                  <dd className="admin-mono">{storage.data.dataDir}</dd>
                </div>
              ) : null}
            </dl>

            {storage.data.items.length ? (
              <div className="admin-table-wrap">
                <table className="admin-table admin-table--runs">
                  <thead>
                    <tr>
                      <th>条目</th>
                      <th>文件数</th>
                      <th>占用</th>
                    </tr>
                  </thead>
                  <tbody>
                    {storage.data.items.map((item) => (
                      <tr key={item.name}>
                        <td className={internal ? 'admin-mono' : ''}>{item.name}</td>
                        <td className="admin-mono">{item.files}</td>
                        <td className="admin-mono">{formatBytes(item.bytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="admin-hint">数据目录还是空的：第一次检索、评审或运行之后，这里会出现真实文件。</p>
            )}

            <p className="admin-hint">
              {internal
                ? `统计时间 ${formatDateTime(storage.data.checkedAt)}；只统计 data 目录，不包含 node_modules 与构建产物。`
                : `统计时间 ${formatDateTime(storage.data.checkedAt)}；只统计业务数据，不包含程序文件。`}
            </p>
          </>
        ) : null}

        {!storage.loading && storage.error ? (
          <p className="admin-hint">占用读取失败：{internal ? storage.error : '稍后刷新再试；如果一直失败，请联系维护人员。'}</p>
        ) : null}
      </section>

      <WaterlineCard />

      <StorageGuard />

      <LogsCard internal={internal} />

      {internal ? <DiagnosticsCard /> : null}
    </>
  )
}

// 前端异常：浏览器自己报上来的（脚本错误、未处理的 Promise、渲染抛错、资源加载失败）。
// 和「告警」分开：告警是服务端 5xx / 上游失败 / 磁盘，这里是用户浏览器里发生的事。
function ClientErrorsCard() {
  const { data, error, loading, reload } = useApi<ClientErrorsInfo>('/api/admin/client-errors?limit=40')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  const clear = async () => {
    setBusy(true)
    setNote('')
    try {
      const result = await request<{ ok: boolean; removed: number }>('/api/admin/client-errors/clear', {
        method: 'POST',
        body: JSON.stringify({}),
      })
      setNote('已清空 ' + result.removed + ' 条上报记录')
      reload()
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : '清空失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="admin-card admin-block">
      <div className="admin-block-head">
        <div>
          <p className="admin-label">前端异常</p>
          <p className="admin-sub">
            用户在浏览器里遇到的脚本错误、未处理的 Promise、页面渲染失败与资源加载失败。
            同一页面同一条错误 {data?.limits.dedupeMin ?? 10} 分钟内合并计数，只留最近 {data?.limits.cap ?? 300} 条。
          </p>
        </div>
        <div className="admin-alert-actions">
          <SourceTag kind="api" source="GET /api/admin/client-errors" />
          <button type="button" className="vq-button vq-button--ghost" onClick={reload} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
          <button
            type="button"
            className="vq-button vq-button--ghost"
            onClick={() => void clear()}
            disabled={busy || !data?.total}
          >
            {busy ? '清空中…' : '清空'}
          </button>
        </div>
      </div>

      {error ? <ErrorBanner message={'GET /api/admin/client-errors：' + error} onRetry={reload} /> : null}
      {loading && !data ? <LoadingLine label="/api/admin/client-errors" /> : null}

      {data ? (
        <>
          <div className="admin-alert-facts">
            <span>
              <b>{data.total}</b> 条聚合记录
            </span>
            <span>
              最近 24 小时 <b>{data.last24h}</b> 次上报
            </span>
          </div>

          {data.items.length ? (
            <ul className="admin-alert-list">
              {data.items.map((item) => (
                <li key={item.id} className="admin-alert-row admin-error-row">
                  <Badge tone={item.kind === 'resource' ? 'warn' : 'fail'}>
                    {CLIENT_ERROR_KIND[item.kind] || item.kind}
                  </Badge>
                  <div className="admin-alert-copy">
                    <strong>{item.message}</strong>
                    <span className="admin-cell-sub admin-mono">
                      第 {item.count} 次 · 最近 {formatDateTime(item.lastAt)} · {item.page || '首页'}
                      {item.version ? ' · v' + item.version : ''}
                    </span>
                    {item.stack ? (
                      <details className="admin-error-details">
                        <summary>堆栈</summary>
                        <pre className="admin-error-stack">{item.stack}</pre>
                      </details>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="admin-hint admin-hint--ok">最近没有前端异常：页面报错、按钮点了没反应这类问题会出现在这里。</p>
          )}
        </>
      ) : null}

      {note ? <p className="admin-hint">{note}</p> : null}
    </section>
  )
}

// 服务端日志：项目自己的 data/logs 按天轮转，保留天数与总量上限都由服务端给。
// systemd journal 另有一套系统级策略，两边互不替代（这里只讲项目日志）。
function LogsCard({ internal }: { internal: boolean }) {
  const { data, error, loading, reload } = useApi<LogsInfo>('/api/admin/logs?limit=40')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  const prune = async () => {
    setBusy(true)
    setNote('')
    try {
      const result = await request<{ ok: boolean; removed: string[]; bytesFreed: number; kept: number }>('/api/admin/logs/prune', {
        method: 'POST',
        body: JSON.stringify({}),
      })
      setNote(
        result.removed.length
          ? '已按保留策略清掉 ' + result.removed.length + ' 个文件（' + formatBytes(result.bytesFreed) + '），剩 ' + result.kept + ' 个'
          : '没有需要清理的文件：都还在保留期内',
      )
      reload()
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : '清理失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="admin-card admin-block">
      <div className="admin-block-head">
        <div>
          <p className="admin-label">服务端日志</p>
          <p className="admin-sub">
            访问、错误、启动事件按天写进 data/logs：超过 {data?.retentionDays ?? 14} 天或总量超过{' '}
            {data?.maxTotalMb ?? 200}MB 就从最旧的开始删。健康检查与静态资源不进访问日志。
          </p>
        </div>
        <div className="admin-alert-actions">
          <SourceTag kind="api" source="GET /api/admin/logs" />
          <button type="button" className="vq-button vq-button--ghost" onClick={reload} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
          <button type="button" className="vq-button vq-button--ghost" onClick={() => void prune()} disabled={busy}>
            {busy ? '清理中…' : '立即清理'}
          </button>
        </div>
      </div>

      {error ? <ErrorBanner message={'GET /api/admin/logs：' + error} onRetry={reload} /> : null}
      {loading && !data ? <LoadingLine label="/api/admin/logs" /> : null}

      {data ? (
        <>
          <div className="admin-alert-facts">
            <span>
              <b>{data.totalFiles}</b> 个文件 · {formatBytes(data.totalBytes)}
            </span>
            <span>
              最早 <b>{data.oldestDay || '—'}</b> · 最新 <b>{data.newestDay || '—'}</b>
            </span>
            <span>
              保留 <b>{data.retentionDays}</b> 天 / 上限 <b>{data.maxTotalMb}</b> MB
            </span>
          </div>

          {data.files.length ? (
            <div className="admin-table-wrap">
              <table className="admin-table admin-table--runs">
                <thead>
                  <tr>
                    <th>文件</th>
                    <th>类型</th>
                    <th>日期</th>
                    <th>大小</th>
                  </tr>
                </thead>
                <tbody>
                  {data.files.map((file) => (
                    <tr key={file.name}>
                      <td className={internal ? 'admin-mono' : ''}>{file.name}</td>
                      <td>{LOG_KIND_LABEL[file.kind] || file.kind}</td>
                      <td className="admin-mono">{file.day}</td>
                      <td className="admin-mono">{formatBytes(file.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="admin-hint">还没有日志文件：下一次请求或启动事件之后会出现在这里。</p>
          )}

          <p className="admin-hint">
            {internal ? '目录 ' + data.dir + '；' : ''}
            清理只在到期或超量时删文件，不会截断当天的日志。systemd journal 的系统级策略另算，两边互不替代。
          </p>
        </>
      ) : null}

      {note ? <p className="admin-hint">{note}</p> : null}
    </section>
  )
}

// 内部环境专用：最近请求与错误只在进程内存里，重启即清空；生产环境该接口直接 404。
function DiagnosticsCard() {
  const { data, error, loading, reload } = useApi<DiagnosticsInfo>('/api/admin/diagnostics')
  const errors = [...(data?.logs.errors ?? [])].reverse().slice(0, 8)
  const requests = [...(data?.logs.access ?? [])].reverse().slice(0, 12)

  return (
    <section className="admin-card admin-block">
      <div className="admin-block-head">
        <div>
          <p className="admin-label">排查信息</p>
          <p className="admin-sub">
            只在内部环境提供：进程、模型配置是否就绪、最近请求与错误都来自当前进程，生产环境不会暴露这个接口。
          </p>
        </div>
        <div className="admin-diag-actions">
          <SourceTag kind="api" source="GET /api/admin/diagnostics" />
          <button type="button" className="vq-button vq-button--ghost" onClick={reload} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>
      </div>

      {error ? <ErrorBanner message={`GET /api/admin/diagnostics：${error}`} onRetry={reload} /> : null}
      {loading && !data ? <LoadingLine label="/api/admin/diagnostics" /> : null}

      {data ? (
        <>
          <dl className="admin-kv">
            <div>
              <dt>进程</dt>
              <dd>
                <span className="admin-mono">PID {data.process.pid} · Node {data.process.node}</span>
                <span className="admin-cell-sub">启动 {formatDateTime(data.process.startedAt)}</span>
              </dd>
            </div>
            <div>
              <dt>运行时长</dt>
              <dd>
                <span className="admin-mono">{formatDuration(data.process.uptimeSec * 1000)}</span>
                <span className="admin-cell-sub">版本 v{data.package.version}</span>
              </dd>
            </div>
            <div>
              <dt>内存</dt>
              <dd>
                <span className="admin-mono">RSS {data.process.memoryMb.rss} MB</span>
                <span className="admin-cell-sub">
                  heap {data.process.memoryMb.heapUsed} / {data.process.memoryMb.heapTotal} MB
                </span>
              </dd>
            </div>
            <div>
              <dt>对话模型</dt>
              <dd>
                <span className="admin-mono">{data.config.models.chat}</span>
                <span className="admin-cell-sub">
                  {data.config.models.chatFallbacks.length ? '降级 ' + data.config.models.chatFallbacks.join(' / ') : '没有配置降级模型'}
                </span>
              </dd>
            </div>
            <div>
              <dt>视觉模型</dt>
              <dd>
                <span className="admin-mono">{data.config.models.vision}</span>
                <span className="admin-cell-sub">
                  {data.config.models.visionModels.length ? '候选 ' + data.config.models.visionModels.join(' / ') : '候选沿用默认'}
                </span>
              </dd>
            </div>
            <div>
              <dt>上游地址</dt>
              <dd className="admin-mono">{data.config.upstream.visionBaseUrl}</dd>
            </div>
            <div>
              <dt>凭证状态</dt>
              <dd>
                模型 {data.config.upstream.visionKeyConfigured ? '已配置' : '未配置'} · 检索{' '}
                {data.config.upstream.searchKeyConfigured ? '已配置' : '未配置'}
              </dd>
            </div>
            <div>
              <dt>网页读取</dt>
              <dd>
                <span>
                  {data.tools.webRead.last
                    ? data.tools.webRead.last.ok
                      ? '最近一次成功 · ' + data.tools.webRead.last.host + ' · ' + data.tools.webRead.last.chars + ' 字'
                      : '最近一次失败 · ' + (data.tools.webRead.last.host || '无来源') + ' · ' + data.tools.webRead.last.code
                    : '本次启动还没有读取记录'}
                </span>
                <span className="admin-cell-sub">
                  {data.tools.webRead.last ? formatDateTime(data.tools.webRead.last.at) : '超时 ' + Math.round(data.config.webRead.timeoutMs / 1000) + ' 秒'}
                </span>
              </dd>
            </div>
            <div>
              <dt>智能体工具</dt>
              <dd>
                <span className="admin-mono">
                  {data.tools.list.filter((tool) => tool.state === 'ready').map((tool) => tool.label).join(' · ')}
                </span>
                <span className="admin-cell-sub">
                  待接入：{data.tools.list.filter((tool) => tool.state !== 'ready').map((tool) => tool.label).join(' / ') || '无'}
                </span>
              </dd>
            </div>
            <div>
              <dt>数据目录</dt>
              <dd className="admin-mono">{data.config.dataDir}</dd>
            </div>
          </dl>

          <div className="admin-diag-grid">
            <section>
              <p className="admin-label">
                最近错误
                <span className="admin-cell-sub">本次启动共 {data.logs.totals.errors} 条</span>
              </p>
              {errors.length ? (
                <ul className="admin-diag-errors">
                  {errors.map((item, index) => (
                    <li key={item.id + '-' + index}>
                      <div className="admin-diag-error-head">
                        <span>{formatDateTime(item.at)}</span>
                        <span className="admin-mono">{item.id || '进程级'}</span>
                      </div>
                      <p>{String(item.msg || '').split('\n')[0] || '（没有错误信息）'}</p>
                      {item.path ? (
                        <span className="admin-cell-sub admin-mono">
                          {item.method || ''} {item.path}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="admin-hint">本次启动以来没有错误。请求走到这里之后产生的 5xx 会出现在这里。</p>
              )}
            </section>

            <section>
              <p className="admin-label">
                最近请求
                <span className="admin-cell-sub">本次启动共 {data.logs.totals.access} 条</span>
              </p>
              {requests.length ? (
                <div className="admin-table-wrap">
                  <table className="admin-table admin-table--diag">
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th>方法</th>
                        <th>路径</th>
                        <th>状态</th>
                        <th>耗时</th>
                      </tr>
                    </thead>
                    <tbody>
                      {requests.map((item, index) => (
                        <tr key={item.id + '-' + index}>
                          <td className="admin-mono">{formatDateTime(item.at)}</td>
                          <td className="admin-mono">{item.m}</td>
                          <td className="admin-mono admin-diag-path" title={item.p}>
                            {item.p}
                          </td>
                          <td>
                            <Badge tone={item.s >= 500 ? 'fail' : item.s >= 400 ? 'warn' : 'ok'}>{item.s}</Badge>
                          </td>
                          <td className="admin-mono">{Math.round(item.ms)} ms</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="admin-hint">还没有请求记录：刷新页面或调一次接口，这里就会出现。</p>
              )}
            </section>
          </div>

          <p className="admin-hint">
            内存里只保留最近 {data.logs.limits.access} 条请求 / {data.logs.limits.errors} 条错误，进程重启即清空；完整访问日志仍在服务器的系统日志里。
            网页读取可用 <span className="admin-mono">POST /api/admin/tools/web-read</span> 单独自检，不经过模型。
          </p>
        </>
      ) : null}
    </section>
  )
}
