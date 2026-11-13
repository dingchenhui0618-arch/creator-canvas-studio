import { useState } from 'react'
import { AlertTriangle, Check, Loader2, X } from 'lucide-react'
import { submitFeedback, type FeedbackKind } from '../api/feedback'
import '../styles/shell.css'

// 应用内反馈：登录页与设置页共用。登录进不来的人也能交（匿名必须留联系方式），
// 所以这里不假设有会话；提交成功只回受理编号，处理结果在「设置 → 帮助与反馈」里看。

const KINDS: { value: FeedbackKind; label: string; hint: string }[] = [
  { value: 'problem', label: '功能问题', hint: '哪一步不对、报了什么错' },
  { value: 'idea', label: '改进建议', hint: '希望多什么、少什么' },
  { value: 'other', label: '其他', hint: '合作、数据或别的疑问' },
]

const MAX_BODY = 2000

export function FeedbackModal({
  onClose,
  signedIn = false,
  defaultContact = '',
  page = '',
}: {
  onClose: () => void
  signedIn?: boolean
  defaultContact?: string
  page?: string
}) {
  const [kind, setKind] = useState<FeedbackKind>('problem')
  const [body, setBody] = useState('')
  const [contact, setContact] = useState(defaultContact)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<{ id: string; duplicate: boolean } | null>(null)

  const location = page || (typeof window !== 'undefined' ? window.location.hash.replace(/^#/, '') : '')

  const submit = async () => {
    if (body.trim().length < 5) {
      setError('请至少写 5 个字，说清遇到什么问题或想要什么')
      return
    }
    if (!signedIn && contact.trim().length < 5) {
      setError('匿名提交需要留一个能联系到你的方式（邮箱 / 微信 / 手机）')
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await submitFeedback({ kind, body: body.trim(), contact: contact.trim(), page: location })
      setDone({ id: result.id, duplicate: result.duplicate })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '提交没有成功')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="vq-modal-backdrop" onMouseDown={onClose}>
      <div className="vq-update-modal vq-feedback-modal" role="dialog" aria-modal="true" aria-labelledby="vq-feedback-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="vq-update-head">
          <div>
            <span className="vq-mono">Support / 反馈</span>
            <h2 id="vq-feedback-title">告诉管理员哪里不对</h2>
          </div>
          <button type="button" className="vq-button vq-button--icon" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {done ? (
          <div className="vq-feedback-done">
            <p className="vq-feedback-done-head">
              <Check size={15} />
              已受理 · <strong>{done.id}</strong>
            </p>
            <p className="vq-feedback-note">
              {done.duplicate ? '同样的内容十分钟内已经交过一次，这条合并到原记录。' : null}
              {signedIn
                ? '管理员在后台能看到这条；处理状态和回复会更新在「设置 → 帮助与反馈」。'
                : '管理员会在后台看到这条；处理结果会通过你留的联系方式回复。'}
            </p>
            <div className="vq-update-actions">
              <button type="button" className="vq-button vq-button--primary" onClick={onClose}>
                关闭
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="vq-feedback-kinds" role="group" aria-label="反馈类型">
              {KINDS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={'vq-feedback-kind' + (kind === item.value ? ' is-active' : '')}
                  aria-pressed={kind === item.value}
                  disabled={busy}
                  onClick={() => setKind(item.value)}
                >
                  <strong>{item.label}</strong>
                  <span>{item.hint}</span>
                </button>
              ))}
            </div>

            <label className="vq-field">
              <span>具体情况（必填）</span>
              <textarea
                className="vq-input vq-feedback-body"
                rows={5}
                maxLength={MAX_BODY}
                value={body}
                disabled={busy}
                placeholder="例如：在画布上点「运行」后，节点一直转圈，刷新后运行记录里是空的。"
                onChange={(event) => setBody(event.target.value)}
              />
            </label>
            <p className="vq-feedback-counter">
              {body.length} / {MAX_BODY}
            </p>

            <label className="vq-field">
              <span>{signedIn ? '联系方式（可选）' : '联系方式（匿名必填）'}</span>
              <input
                className="vq-input"
                value={contact}
                disabled={busy}
                maxLength={120}
                placeholder={signedIn ? '默认用账号邮箱，也可以填微信 / 手机' : '邮箱 / 微信 / 手机，处理结果要靠它回复'}
                onChange={(event) => setContact(event.target.value)}
              />
            </label>

            {error ? (
              <p className="vq-inline-error" role="alert">
                <AlertTriangle size={13} /> {error}
              </p>
            ) : null}

            <p className="vq-feedback-note">
              提交时会带上当前页面（{location || '首页'}）和浏览器信息，方便定位；这些只给管理员看。
              {signedIn ? '不需要留联系方式也能收到回复。' : '不登录也能提交，我们不会公开你的联系方式。'}
            </p>

            <div className="vq-update-actions">
              <button type="button" className="vq-button vq-button--primary" onClick={() => void submit()} disabled={busy}>
                {busy ? <Loader2 size={14} className="vq-spin" /> : null}
                {busy ? '提交中…' : '提交反馈'}
              </button>
              <button type="button" className="vq-button vq-button--ghost" onClick={onClose} disabled={busy}>
                取消
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
