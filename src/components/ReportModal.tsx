import { useState } from 'react'
import { AlertTriangle, Check, Loader2, X } from 'lucide-react'
import { submitReport, type ReportCategory, type ReportTarget } from '../api/reports'
import { Select } from './Select'
import '../styles/shell.css'

// 举报侵权 / 不当内容：不要求登录。只填「类型 + 具体情况」就能提交；
// 联系方式可选，留了方便回复处理结果。提交后显示受理编号，管理员在后台「举报处理」里处理。

const CATEGORIES: { value: ReportCategory; label: string; hint: string }[] = [
  { value: 'copyright', label: '版权 / 搬运', hint: '原片或脚本是我方作品，未经授权被收录或分享' },
  { value: 'portrait', label: '肖像 / 隐私', hint: '画面里的人像、姓名或其它个人信息未经同意' },
  { value: 'abuse', label: '不当内容', hint: '违法、暴力、低俗或其它不该出现的内容' },
  { value: 'other', label: '其他', hint: '不属于上面几类，请在下面说明' },
]

export function ReportModal({
  target,
  onClose,
  onDone,
}: {
  target: ReportTarget
  onClose: () => void
  onDone?: (message: string) => void
}) {
  const [category, setCategory] = useState<ReportCategory>('copyright')
  const [detail, setDetail] = useState('')
  const [contact, setContact] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<{ id: string; duplicate: boolean } | null>(null)

  const submit = async () => {
    if (detail.trim().length < 5) {
      setError('请说明具体情况（至少 5 个字），例如「这条视频的脚本是我写的，未授权」')
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await submitReport({ target, category, detail: detail.trim(), contact: contact.trim() })
      setDone({ id: result.id, duplicate: result.duplicate })
      onDone?.('举报已提交，受理编号 ' + result.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '提交没有成功')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="vq-modal-backdrop" onMouseDown={onClose}>
      <div className="vq-update-modal vq-report-modal" role="dialog" aria-modal="true" aria-labelledby="vq-report-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="vq-update-head">
          <div>
            <span className="vq-mono">Report / 举报</span>
            <h2 id="vq-report-title">举报侵权或不当内容</h2>
          </div>
          <button type="button" className="vq-button vq-button--icon" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {done ? (
          <div className="vq-report-done">
            <p>
              <Check size={15} />
              已收到受理编号 <strong>{done.id}</strong>
              {done.duplicate ? '（同一对象短时间内重复提交，已合并）' : ''}。
            </p>
            <p className="vq-report-note">
              我们会核对来源与授权情况；需要下架的公共模板会从模板库和分享链接里撤下。留下联系方式的会收到处理结果。
            </p>
            <div className="vq-update-actions">
              <button type="button" className="vq-button vq-button--primary" onClick={onClose}>
                关闭
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="vq-report-target">
              举报对象：<strong>{target.title || target.id}</strong>
            </p>

            <label className="vq-field">
              <span>类型</span>
              <Select
                className="vq-select--block"
                label="举报类型"
                value={category}
                options={CATEGORIES.map((item) => ({ value: item.value, label: item.label }))}
                disabled={busy}
                onChange={(value) => setCategory(value as ReportCategory)}
              />
            </label>
            <p className="vq-report-hint">{CATEGORIES.find((item) => item.value === category)?.hint}</p>

            <label className="vq-field">
              <span>具体情况（必填）</span>
              <textarea
                className="vq-input vq-report-detail"
                rows={4}
                value={detail}
                onChange={(event) => setDetail(event.target.value)}
                placeholder="例如：这条视频的画面与脚本是我方 2026-10 拍摄的作品，未授权任何平台收录或二次分发。"
                disabled={busy}
              />
            </label>

            <label className="vq-field">
              <span>联系方式（可选）</span>
              <input className="vq-input" value={contact} onChange={(event) => setContact(event.target.value)} placeholder="邮箱或其它能联系到你的方式" disabled={busy} />
            </label>

            {error ? (
              <p className="vq-inline-error" role="alert">
                <AlertTriangle size={13} /> {error}
              </p>
            ) : null}

            <p className="vq-report-note">
              提交内容会连同这条模板的来源、标题与链接一起记进处理队列；恶意举报同样会被记录。
              不需要登录也能提交，我们不会把联系方式展示给其他人。
            </p>

            <div className="vq-update-actions">
              <button type="button" className="vq-button vq-button--primary" onClick={() => void submit()} disabled={busy}>
                {busy ? <Loader2 size={14} className="vq-spin" /> : null}
                {busy ? '提交中…' : '提交举报'}
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
