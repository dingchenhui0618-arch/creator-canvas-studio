import { useState } from 'react'
import type { UpstreamBalanceChannel } from '../../api/adminBalance'
import { checkUpstreamBalance, saveUpstreamBalanceChannel } from '../../api/adminBalance'
import { formatDateTime, useApi } from './data'
import { Badge, ErrorBanner, LoadingLine, RefreshButton, SourceTag } from './ui'
import type { UpstreamBalanceResponse } from '../../api/adminBalance'

// 上游渠道余额：按渠道列清楚「还剩多少钱」，低于阈值标红。
//
// 两条来源必须分开写，否则会被当成同一个实时数：
//   - GeteAPI（New API 底座）→ 账号访问令牌自动读 /api/user/self；
//   - SeeAPI / CGCM         → 上游没有余额接口，只能按对账单手动登记。
// 令牌输入框是空的表示「不修改」；要清掉得点「清掉令牌」。

type Draft = {
  channelId: string
  accessToken: string
  newApiUser: string
  threshold: string
  manualAmount: string
}

function money(channel: UpstreamBalanceChannel, value: number | null) {
  if (value === null || value === undefined) return '—'
  return (channel.currency || '') + value.toFixed(2)
}

function sourceLabel(channel: UpstreamBalanceChannel) {
  if (channel.source === 'auto') return '自动读取'
  if (channel.source === 'manual') return '手动登记'
  return '还没核对'
}

function stateBadge(channel: UpstreamBalanceChannel) {
  if (channel.state === 'low') return <Badge tone="fail">低于阈值</Badge>
  if (channel.state === 'ok') return <Badge tone="ok">正常</Badge>
  return <Badge tone="neutral">未核对</Badge>
}

export default function UpstreamBalanceCard() {
  const [tick, setTick] = useState(0)
  const { data, error, loading } = useApi<UpstreamBalanceResponse>(
    '/api/admin/upstream-balance' + (tick ? '?t=' + tick : ''),
  )
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')

  const channels = data?.channels || []

  const openEditor = (channel: UpstreamBalanceChannel, mode: 'settings' | 'manual') => {
    setNotice('')
    setFailure('')
    setDraft({
      channelId: channel.id + ':' + mode,
      accessToken: '',
      newApiUser: '',
      threshold: String(channel.threshold),
      manualAmount: channel.amount === null ? '' : String(channel.amount),
    })
  }

  const save = async (channel: UpstreamBalanceChannel, mode: 'settings' | 'manual') => {
    if (!draft || busy) return
    setBusy('save')
    setFailure('')
    try {
      const input: Parameters<typeof saveUpstreamBalanceChannel>[0] = {
        channelId: channel.id,
        threshold: Number(draft.threshold),
      }
      if (draft.accessToken.trim()) input.accessToken = draft.accessToken.trim()
      if (draft.newApiUser.trim()) input.newApiUser = draft.newApiUser.trim()
      if (mode === 'manual') input.manualAmount = draft.manualAmount.trim() === '' ? null : Number(draft.manualAmount)
      const saved = await saveUpstreamBalanceChannel(input)
      setDraft(null)
      setNotice(
        saved.tokenKept
          ? '已保存（令牌沿用原来那把）。'
          : mode === 'manual'
            ? '已登记余额。'
            : '已保存。',
      )
      setTick(Date.now())
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      setBusy('')
    }
  }

  const check = async (channel: UpstreamBalanceChannel) => {
    if (busy) return
    setBusy(channel.id)
    setFailure('')
    setNotice('')
    try {
      const result = await checkUpstreamBalance(channel.id)
      if (!result.ok) {
        setFailure(result.error || '上游没有返回余额')
      } else {
        setNotice(channel.label + ' 余额 ' + money({ ...channel, currency: result.channel.currency || channel.currency }, result.channel.amount))
      }
      setTick(Date.now())
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : '核对失败')
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="admin-card admin-block">
      <div className="admin-block-head">
        <div>
          <p className="admin-label">上游渠道余额</p>
          <p className="admin-sub">
            按渠道列清楚还剩多少钱，低于阈值标红。主通道 A 用账号访问令牌自动读；主通道 B
            上游没有余额接口，只能按对账单手动登记 —— 两种来源分列，别把它当成同一个实时数。
          </p>
        </div>
        <div className="balance-head-actions">
          <SourceTag kind="api" source="GET /api/admin/upstream-balance" />
          <RefreshButton onClick={() => setTick(Date.now())} busy={loading} />
        </div>
      </div>

      {error ? <ErrorBanner message={error} onRetry={() => setTick(Date.now())} /> : null}
      {loading && !data ? <LoadingLine label="/api/admin/upstream-balance" /> : null}
      {notice ? <p className="admin-hint balance-notice">{notice}</p> : null}
      {failure ? <p className="balance-error">{failure}</p> : null}

      {channels.length ? (
        <div className="admin-table-wrap">
          <table className="admin-table balance-table">
            <thead>
              <tr>
                <th>渠道</th>
                <th>余额</th>
                <th>阈值</th>
                <th>状态</th>
                <th>最后核对</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((channel) => {
                const editing = draft && draft.channelId.startsWith(channel.id + ':')
                return (
                  <tr key={channel.id} className={editing ? 'is-editing' : undefined}>
                    <td data-label="渠道">
                      <strong>{channel.label}</strong>
                      <span className="admin-cell-sub">
                        {channel.kind === 'newapi' ? 'New API：访问令牌读 /api/user/self' : '没有余额接口：手动登记'}
                      </span>
                    </td>
                    <td data-label="余额">
                      <strong className={'balance-amount' + (channel.state === 'low' ? ' is-low' : '')}>
                        {money(channel, channel.amount)}
                      </strong>
                      <span className="admin-cell-sub">
                        {sourceLabel(channel)}
                        {channel.used !== null ? ' · 已用 ' + money(channel, channel.used) : ''}
                      </span>
                      {channel.error ? <span className="balance-error">{channel.error}</span> : null}
                    </td>
                    <td data-label="阈值">
                      <span className="admin-mono">{money(channel, channel.threshold)}</span>
                    </td>
                    <td data-label="状态">{stateBadge(channel)}</td>
                    <td data-label="最后核对">
                      <span className="admin-cell-sub">
                        {channel.checkedAt ? formatDateTime(channel.checkedAt) : '还没核对过'}
                      </span>
                    </td>
                    <td data-label="操作">
                      <div className="balance-actions">
                        {channel.kind === 'newapi' ? (
                          <button
                            type="button"
                            className="vq-button vq-button--ghost"
                            disabled={!channel.hasToken || busy === channel.id}
                            onClick={() => check(channel)}
                            title={channel.hasToken ? '现在真打一次上游账号接口' : '先填访问令牌'}
                          >
                            {busy === channel.id ? '核对中' : '现在核对'}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="vq-button vq-button--ghost"
                          onClick={() => openEditor(channel, channel.kind === 'newapi' ? 'settings' : 'manual')}
                        >
                          {channel.kind === 'newapi' ? '令牌与阈值' : '登记余额'}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {draft ? (
        <div className="balance-editor">
          {(() => {
            const channel = channels.find((item) => draft.channelId.startsWith(item.id + ':'))
            if (!channel) return null
            const mode = draft.channelId.endsWith(':manual') ? 'manual' : 'settings'
            return (
              <>
                <p className="admin-label">
                  {channel.label} · {mode === 'manual' ? '登记余额' : '访问令牌与阈值'}
                </p>
                {mode === 'settings' ? (
                  <div className="balance-form">
                    <label className="admin-edit-field">
                      <span>访问令牌{channel.hasToken ? '（已存 ' + channel.tokenMask + '，留空不改）' : ''}</span>
                      <input
                        type="password"
                        autoComplete="off"
                        placeholder={channel.hasToken ? '留空沿用原来的令牌' : '在渠道控制台 → 设置 → 访问令牌 生成'}
                        value={draft.accessToken}
                        onChange={(event) => setDraft({ ...draft, accessToken: event.target.value })}
                      />
                    </label>
                    <label className="admin-edit-field">
                      <span>New API 用户 ID（可选，接口 401 时填）</span>
                      <input
                        inputMode="numeric"
                        placeholder={channel.hasNewApiUser ? '已填过，留空不改' : '控制台个人设置里的数字 ID'}
                        value={draft.newApiUser}
                        onChange={(event) => setDraft({ ...draft, newApiUser: event.target.value })}
                      />
                    </label>
                  </div>
                ) : (
                  <div className="balance-form">
                    <label className="admin-edit-field">
                      <span>当前余额（与渠道同一货币）</span>
                      <input
                        inputMode="decimal"
                        placeholder="例如 128.50"
                        value={draft.manualAmount}
                        onChange={(event) => setDraft({ ...draft, manualAmount: event.target.value })}
                      />
                    </label>
                  </div>
                )}
                <div className="balance-form">
                  <label className="admin-edit-field">
                    <span>低于多少钱标红</span>
                    <input
                      inputMode="decimal"
                      value={draft.threshold}
                      onChange={(event) => setDraft({ ...draft, threshold: event.target.value })}
                    />
                  </label>
                </div>
                <div className="balance-form-actions">
                  <button type="button" className="vq-button" disabled={busy === 'save'} onClick={() => save(channel, mode)}>
                    {busy === 'save' ? '保存中' : '保存'}
                  </button>
                  <button type="button" className="vq-button vq-button--ghost" onClick={() => setDraft(null)}>
                    取消
                  </button>
                </div>
              </>
            )
          })()}
        </div>
      ) : null}

      <p className="admin-hint">
        主通道 A 的分组倍率与价格来自公开价目表；余额来自账号接口的 quota ÷ quota_per_unit。中转 Key
        本身读不到余额（/v1/dashboard 那个硬限额是占位值），别拿它当余额。
      </p>
    </section>
  )
}
