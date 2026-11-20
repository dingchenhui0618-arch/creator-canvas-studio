import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowLeftRight, Check, ClipboardCheck, Link2Off, Loader2, RefreshCw, WifiOff, X } from 'lucide-react'
import { ackReceiptByLink, getReceiptLink, submitReceiptByLink } from '../api/projects'
import { receiptCheckLabel } from '../domain/project'
import { receiptLinkRead, type ReceiptLinkRead } from '../domain/receipt-link-read'
import type { DeliveryReceipt, ReceiptLinkResult, ReceiptLinkView } from '../domain/project'
import '../styles/receipt-page.css'

// 回执链接（v0.9.137）：发件人把这条地址发给收包人，收包人不用注册，
// 打开就是「把收据贴上来」这一件事。这一段文字只用来跟那一份封存包比对，
// 结果写回发件人的交付档案；页面本身不显示包的哈希，也不显示作品的其他内容。

const STATE_LABEL: Record<string, string> = {
  match: '对得上',
  mismatch: '对不上',
  broken: '你那边读不出来',
  conflict: '说法打架',
}

const pad2 = (value: number) => String(value).padStart(2, '0')

/** 2026-11-15 06:48 → 11-15 06:48（与作品页档案里同一个写法） */
function stamp(iso: string): string {
  const ms = Date.parse(String(iso || ''))
  if (!Number.isFinite(ms)) return ''
  const date = new Date(ms)
  return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

function bytesLabel(bytes: number): string {
  const value = Math.max(0, Math.round(Number(bytes) || 0))
  return value ? value.toLocaleString('zh-CN') + ' B' : ''
}

// 「收包人那边读不出来」是发件人那一侧的说法；收包人自己看到这句要换成「你」。
function receiverSummary(state: string, summary: string): string {
  if (state === 'broken') return '你那边读不出来：包可能没下全，找发件人重发一份更稳。'
  return summary || ''
}

function ReceiptTopbar() {
  return (
    <header className="rpage-topbar">
      <div className="rpage-brand">
        <span className="rpage-brand-dot" aria-hidden="true" />
        <span className="rpage-brand-name">VisionQA</span>
        <span className="rpage-badge">收据回执</span>
      </div>
      <span className="rpage-mono">收件核对</span>
    </header>
  )
}

// 「这一条打不开」的那几种状态也顶着同一条品牌栏（v0.9.148）：
// 收包人是从聊天记录里点进来的，先要认出这是 VisionQA 那一页，而不是浏览器报错。
function CenterShell({ children }: { children: ReactNode }) {
  return (
    <div className="rpage rpage--center">
      <ReceiptTopbar />
      {children}
    </div>
  )
}

export default function ReceiptPage({ token }: { token: string }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  // 没读回来时是哪一种（v0.9.257）：换成新的了 / 真不在了 / 这一下没打开
  const [fail, setFail] = useState<ReceiptLinkRead | null>(null)
  // 点「再试一次」把它加一：同一个 token 重新取一次，不刷新整页
  const [reload, setReload] = useState(0)
  const [view, setView] = useState<ReceiptLinkView | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ReceiptLinkResult | null>(null)
  // 「收到了」那一句（v0.9.151）：发件人那边等的是收据，可验完之前他至少该知道东西到了。
  // 读了页面就知道自己点过没有，刷新也不重复点。
  const [ackAt, setAckAt] = useState('')
  const [ackBusy, setAckBusy] = useState(false)

  useEffect(() => {
    const previous = document.title
    document.title = 'VisionQA 收据回执'
    return () => {
      document.title = previous
    }
  }, [])

  useEffect(() => {
    let alive = true
    getReceiptLink(token)
      .then((next) => {
        if (!alive) return
        setView(next)
        setAckAt(next.ackAt || '')
        setStatus('ready')
      })
      .catch((caught: unknown) => {
        if (!alive) return
        // 换掉的旧地址（v0.9.148）、真不在了（404）与这一次没读到（断网 / 5xx）是三件事：
        // 前两种才叫「链接不在了」，最后一种让他在原地再点一次（r275）。
        setFail(receiptLinkRead(caught))
        setStatus('failed')
      })
    return () => {
      alive = false
    }
  }, [token, reload])

  // 已经贴过的结论：刚贴的这一份优先，其次是打开页面时读到的上一次
  const shown = useMemo<DeliveryReceipt['state'] | ''>(() => result?.state || view?.receipt?.state || '', [result, view])

  const submit = async () => {
    if (!draft.trim()) {
      setError('先把收据整段贴进来')
      return
    }
    setBusy(true)
    setError('')
    try {
      const next = await submitReceiptByLink(token, draft)
      setResult(next)
      setView((prev) => (prev ? { ...prev, receipt: { state: next.state, at: next.at, summary: next.summary } } : prev))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '这段收据没贴上去')
    } finally {
      setBusy(false)
    }
  }

  // 这一次没读到时原地再取一次：同一个 token、同一页，不刷新浏览器、也不让收包人换链接
  const retry = () => {
    setStatus('loading')
    setFail(null)
    setReload((value) => value + 1)
  }

  // 点一下「收到了」：只写一件事，不比对、不改包；发件人那一行会写成「他点了「收到了」，收据还没贴」。
  const ackReceived = async () => {
    if (ackBusy || ackAt) return
    setAckBusy(true)
    setError('')
    try {
      const next = await ackReceiptByLink(token)
      setAckAt(next.at)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '这一下没告诉他，过一会儿再点')
    } finally {
      setAckBusy(false)
    }
  }

  if (status === 'loading') {
    return (
      <CenterShell>
        <div className="rpage-state">
          <Loader2 size={16} className="vq-spin" />
          <span>正在打开回执</span>
        </div>
      </CenterShell>
    )
  }

  // 换掉的旧地址（v0.9.148）：他点的是聊天记录里那一条。说清哪一天换的、包没动、去哪儿拿新的，
  // 再说一句「找不到就回我一句」——旧地址不知道新地址，也不该把新地址给出去（换掉它就是为了不让这条再能用）。
  if (status === 'failed' && fail?.kind === 'retired') {
    const retiredAt = fail.retiredAt
    return (
      <CenterShell>
        <div className="rpage-state is-retired">
          <ArrowLeftRight size={20} />
          <strong>这条地址已经换成新的了</strong>
          <p>
            {retiredAt ? '发件人在 ' + stamp(retiredAt) + ' 把这条回执链接换掉了：' : '发件人已经把这条回执链接换掉了：'}
            旧地址从那时候起就打不开了，用最后发给你的那条。
          </p>
          <p className="rpage-state-note">手上的包不用重下；要是找不到新的那条，回他一句，让他再发一次。</p>
        </div>
      </CenterShell>
    )
  }

  // 真不在了（404）：服务端明确说过没有这一条，这一句才对得上收包人该做的事
  if (status === 'failed' && fail?.kind === 'gone') {
    return (
      <CenterShell>
        <div className="rpage-state is-missing">
          <Link2Off size={20} />
          <strong>{fail.title}</strong>
          <p>{fail.copy}</p>
          {fail.detail ? <span className="rpage-state-detail">{fail.detail}</span> : null}
          <p className="rpage-state-note">{fail.note}</p>
        </div>
      </CenterShell>
    )
  }

  // 这一次没读到（断网 / 5xx）：链接本身没问题，原地再点一次；不许说成「不在了」（r275）
  if (status === 'failed' && fail?.kind === 'unreadable') {
    return (
      <CenterShell>
        <div className="rpage-state is-unreadable">
          <WifiOff size={20} />
          <strong>{fail.title}</strong>
          <p>{fail.copy}</p>
          <button type="button" className="rpage-button" onClick={retry}>
            <RefreshCw size={14} />{fail.retry}
          </button>
          <span className="rpage-state-detail">{fail.detail}</span>
          <p className="rpage-state-note">{fail.note}</p>
        </div>
      </CenterShell>
    )
  }

  // 兜底：没读到视图（也不该走到这里）就停在「正在打开回执」，不摆一屏空内容
  if (status !== 'ready' || !view) {
    return (
      <CenterShell>
        <div className="rpage-state">
          <Loader2 size={16} className="vq-spin" />
          <span>正在打开回执</span>
        </div>
      </CenterShell>
    )
  }

  const delivery = view.delivery

  return (
    <div className="rpage">
      <ReceiptTopbar />

      <main className="rpage-doc">
        <header className="rpage-head">
          <span className="rpage-kicker">把收据贴回来，对一遍</span>
          <h1>{view.project.title}</h1>
          <div className="rpage-meta">
            <span className="rpage-mono">{'第 ' + delivery.version + ' 版'}</span>
            <span className="rpage-mono">{delivery.fileName}</span>
            {bytesLabel(delivery.bytes) ? <span className="rpage-mono">{bytesLabel(delivery.bytes)}</span> : null}
            {stamp(delivery.at) ? <span>发出 {stamp(delivery.at)}</span> : null}
          </div>
          <p className="rpage-lede">
            解压那份交付包，双击里面的「校验.html」，把 zip 拖进去，它会自己算一遍；
            核对完点「带走这份结论」，把那段文字整段复制下来，贴到下面。
          </p>
        </header>

        {view.receipt && !result ? (
          <p className={'rpage-already is-' + view.receipt.state}>
            这一份之前核对过：{STATE_LABEL[view.receipt.state] || view.receipt.state}
            {stamp(view.receipt.at) ? ' · ' + stamp(view.receipt.at) : ''}。
            再贴一次会记在它后面，发件人那边两次都看得到。
          </p>
        ) : null}

        {/* 「收到了」那一下（v0.9.151）：贴收据之前唯一能说的一句话。
            说清两件事：这一步不是验；点完发件人就不用再问「到底收到没有」。 */}
        {!shown ? (
          <section className={'rpage-ack' + (ackAt ? ' is-done' : '')} aria-label="告诉发件人东西收到了">
            <div className="rpage-ack-copy">
              <strong>
                {ackAt ? <Check size={13} /> : null}
                {ackAt ? '已经告诉他了' : '东西收到了吗？'}
              </strong>
              <span>
                {ackAt
                  ? stamp(ackAt) + ' 点的。发件人那边已经知道东西到你手上了；验完照旧把下面那栏的收据贴回来，那才算验过。'
                  : '点一下，发件人那边就知道你拿到了，不用再发消息问你。这一步不算验，验完再贴下面的收据。'}
              </span>
            </div>
            {ackAt ? null : (
              <button
                type="button"
                className="rpage-button"
                disabled={ackBusy}
                onClick={() => void ackReceived()}
                title="只告诉发件人「东西到了」：不比对任何东西，也不改这一份包"
              >
                {ackBusy ? '正在告诉他…' : '东西收到了，正在验'}
              </button>
            )}
          </section>
        ) : null}

        <label className="rpage-field">
          <span className="rpage-label">收据</span>
          <textarea
            className="rpage-input"
            rows={7}
            spellCheck={false}
            aria-label="收据原文"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            placeholder={
              'VisionQA 交付包核对 · ' + view.project.title + ' v' + delivery.version + '\n' +
              '包：' + delivery.fileName + '\n' +
              '结论：都对得上 · …\n' +
              '整包：… B · SHA-256 …\n' +
              '时间：…'
            }
          />
        </label>

        <div className="rpage-actions">
          <button type="button" className="rpage-button is-primary" disabled={busy || !draft.trim()} onClick={() => void submit()}>
            {busy ? '正在对…' : '贴上去对一遍'}
          </button>
          <button
            type="button"
            className="rpage-button"
            disabled={busy || !draft}
            onClick={() => {
              setDraft('')
              setError('')
            }}
          >
            清空
          </button>
          <span className="rpage-hint">只比对版次、包名、字节、整包 SHA-256 与结论五项；收据原文不存。</span>
        </div>

        {error ? (
          <p className="rpage-note is-bad" role="alert">
            {error}
          </p>
        ) : null}

        {shown ? (
          <div className={'rpage-result is-' + shown} role="status">
            <div className="rpage-result-head">
              <strong>
                {shown === 'match' ? <Check size={14} /> : <X size={14} />}
                {shown === 'match' ? '对得上' : STATE_LABEL[shown] || shown}
              </strong>
              <span className="rpage-result-when">
                {result ? '这一次贴的' : '之前贴的'}
                {stamp(result?.at || view.receipt?.at || '') ? ' · ' + stamp(result?.at || view.receipt?.at || '') : ''}
              </span>
            </div>
            {result ? <p className="rpage-result-summary">{receiverSummary(shown, result.summary)}</p> : null}
            {result?.checks?.length ? (
              <ul className="rpage-checks">
                {result.checks.map((check) => (
                  <li key={check.k} className={check.ok ? 'is-ok' : 'is-bad'}>
                    <span className="rpage-check-mark">{check.ok ? <Check size={12} /> : <X size={12} />}</span>
                    <span className="rpage-check-name">{receiptCheckLabel(check.k)}</span>
                    <span className="rpage-check-state">{check.ok ? '一致' : '不一样'}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {result?.problems?.length ? (
              <ul className="rpage-problems">
                {result.problems
                  .filter((line) => line.replace(/[。.]$/, '') !== (result.summary || '').replace(/[。.]$/, ''))
                  .map((line) => (
                    <li key={line}>{line}</li>
                  ))}
              </ul>
            ) : null}
            <p className="rpage-result-note">
              <ClipboardCheck size={12} />
              这一次比对已经记在发件人那一侧的交付档案里，你不用再发一遍。
            </p>
          </div>
        ) : null}

        <p className="rpage-foot">
          这一页只认这条链接：打开它不会看到作品的其他内容，也改不到包里的任何东西。
        </p>
      </main>
    </div>
  )
}
