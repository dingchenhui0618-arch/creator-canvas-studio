import { useState } from 'react'
import { AlertCircle, Download, Loader2, Trash2 } from 'lucide-react'
import { deleteAccount, downloadAccountExport } from '../api/account'
import '../styles/shell.css'

// 账号数据卡：导出（带走副本）与注销（可选择连内容一起删）。
// 注销是不可逆动作：要求输入口令 + 手打「注销」两个字，按钮才可用；成功后清本地会话回登录页。

export function AccountDataCard({ email, onSignedOut }: { email: string; onSignedOut: () => void }) {
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [deleteContent, setDeleteContent] = useState(true)

  const exportData = async () => {
    setBusy('export')
    setError('')
    setMessage('')
    try {
      const result = await downloadAccountExport()
      const kb = Math.max(1, Math.round(result.bytes / 1024))
      setMessage('已导出 ' + result.name + '（约 ' + kb + ' KB）：账号资料、积分流水、模板、画布流程、运行记录、智能体与评审历史。')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '导出没有完成')
    } finally {
      setBusy('')
    }
  }

  const remove = async () => {
    setBusy('delete')
    setError('')
    setMessage('')
    try {
      const result = await deleteAccount({ password, confirm, deleteContent })
      const removed = result.removed
      setMessage(
        '账号已注销：' +
          (result.deleteContent
            ? '同时删除了模板 ' + removed.templates + ' 条、画布流程 ' + removed.flows + ' 个、智能体 ' + removed.agents + ' 个、评审记录 ' + removed.reviews + ' 条。'
            : '你创建的内容按你的选择保留在库里（不再有登录主人）。'),
      )
      onSignedOut()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '注销没有完成')
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="vq-card vq-card--wide" id="account-data">
      <div className="vq-card-head">
        <div>
          <span className="vq-mono">数据 / Data</span>
          <h2>导出与注销</h2>
          <p>
            导出是一份 JSON：账号资料（不含口令与两步验证密钥）、积分流水、模板（含回收站里的）、画布流程与运行记录、智能体、评审历史。
            换平台、留档或注销前先导一份。
          </p>
        </div>
      </div>

      {message ? <p className="vq-inline-ok" role="status">{message}</p> : null}
      {error ? (
        <p className="vq-inline-error" role="alert">
          <AlertCircle size={13} /> {error}
        </p>
      ) : null}

      <div className="vq-2fa-actions">
        <button className="vq-button vq-button--primary" onClick={() => void exportData()} disabled={busy === 'export'}>
          {busy === 'export' ? <Loader2 size={14} className="vq-spin" /> : <Download size={14} />}
          导出我的数据（JSON）
        </button>
      </div>

      <div className="vq-account-danger">
        <div className="vq-account-danger-head">
          <div>
            <strong>注销账号</strong>
            <p>注销后这个邮箱不能再登录，会话与积分流水一起清除；这是不可逆动作，先把数据导出去。</p>
          </div>
          {expanded ? (
            <button className="vq-button vq-button--ghost" onClick={() => setExpanded(false)} disabled={busy === 'delete'}>
              收起
            </button>
          ) : (
            <button className="vq-button vq-button--danger" onClick={() => setExpanded(true)}>
              <Trash2 size={14} />
              我要注销账号
            </button>
          )}
        </div>

        {expanded ? (
          <div className="vq-account-danger-body">
            <label className="vq-field">
              <span>确认邮箱</span>
              <input className="vq-input" value={email} readOnly />
            </label>
            <label className="vq-field">
              <span>当前口令</span>
              <input
                className="vq-input"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
              />
            </label>
            <label className="vq-field">
              <span>输入「注销」两个字确认</span>
              <input className="vq-input" value={confirm} onChange={(event) => setConfirm(event.target.value)} placeholder="在这里输入：注销" />
            </label>
            <label className="vq-check vq-account-danger-check">
              <input type="checkbox" checked={deleteContent} onChange={(event) => setDeleteContent(event.target.checked)} />
              <span>同时删除我创建的模板、画布流程、智能体与评审记录（不勾选则内容保留在库里，但不再有登录主人）</span>
            </label>
            <div className="vq-2fa-actions">
              <button
                className="vq-button vq-button--danger"
                onClick={() => void remove()}
                disabled={busy === 'delete' || !password || confirm.trim() !== '注销'}
              >
                {busy === 'delete' ? <Loader2 size={14} className="vq-spin" /> : <Trash2 size={14} />}
                确认注销账号
              </button>
              <button className="vq-button vq-button--ghost" onClick={() => setExpanded(false)} disabled={busy === 'delete'}>
                取消
              </button>
            </div>
            <p className="vq-2fa-note">最后一个管理员账号不能在这里注销：先把另一个账号设为管理员。</p>
          </div>
        ) : null}
      </div>
    </section>
  )
}
