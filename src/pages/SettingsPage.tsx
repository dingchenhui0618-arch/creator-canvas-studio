import { useState } from 'react'
import { ChevronDown, LogOut, RefreshCw, ShieldCheck } from 'lucide-react'
import { Capability, MonoTag } from '../components/ui'
import { initialsFor, sessionKindLabel, type Session } from '../auth/session'
import '../styles/shell.css'

type Props = {
  session: Session
  onSignOut: () => void
  onSwitchAccount: () => void
}

export function SettingsPage({ session, onSignOut, onSwitchAccount }: Props) {
  const [language, setLanguage] = useState<'zh' | 'en'>('zh')
  const [autoSave, setAutoSave] = useState(true)
  const [runNotify, setRunNotify] = useState(true)

  const guest = session.user.kind === 'guest'
  const credentialRow = guest ? '访客 · 不发凭据' : 'vq_session · HttpOnly cookie'
  const signedInAt = new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(session.signedInAt))

  return (
    <div className="vq-page">
      <header className="vq-page-head">
        <div>
          <span className="vq-mono">Workspace settings</span>
          <h1>设置</h1>
          <p>账号、运行适配器与工作区偏好。敏感密钥不会进入前端，前端只依赖能力接口。</p>
        </div>
      </header>

      <div className="vq-settings-grid">
        <section className="vq-card vq-card--wide">
          <div className="vq-card-head">
            <div>
              <span className="vq-mono">账号 / Account</span>
              <h2>当前会话</h2>
              <p>会话保存在服务端，凭据是 HttpOnly cookie；关掉浏览器再打开仍是登录状态。</p>
            </div>
            <MonoTag>{sessionKindLabel(session.user.kind)}</MonoTag>
          </div>
          <div className="vq-account">
            <span className="vq-account-avatar">{initialsFor(session.user.name)}</span>
            <div className="vq-account-meta">
              <strong>{session.user.name}</strong>
              <span>{session.user.email}</span>
            </div>
            <div className="vq-account-actions">
              <button type="button" className="vq-button vq-button--ghost" onClick={onSwitchAccount}>
                <RefreshCw size={14} />
                切换账号
              </button>
              <button type="button" className="vq-button vq-button--danger" onClick={onSignOut}>
                <LogOut size={14} />
                退出登录
              </button>
            </div>
          </div>
          <div className="vq-card-body">
            <div className="vq-row">
              <div className="vq-row-copy">
                <strong>会话存储</strong>
                <span>{guest ? '访客模式不落任何凭据，刷新即回到登录页' : '客户端只持 cookie；服务端只存 token 的 sha256'}</span>
              </div>
              <span className="vq-row-value vq-mono">{credentialRow}</span>
            </div>
            <div className="vq-row">
              <div className="vq-row-copy">
                <strong>登录方式</strong>
                <span>{guest ? '跳过鉴权，直接用示例数据浏览' : '邮箱 + 口令，服务端 scrypt 比对；密码不存明文'}</span>
              </div>
              <span className="vq-row-value">{sessionKindLabel(session.user.kind)}</span>
            </div>
            <div className="vq-row">
              <div className="vq-row-copy">
                <strong>本次登录时间</strong>
                <span>服务端会话的创建时间，用于会话过期判断</span>
              </div>
              <span className="vq-row-value vq-mono">{signedInAt}</span>
            </div>
          </div>
        </section>

        <section className="vq-card">
          <div className="vq-card-head">
            <div>
              <span className="vq-mono">Run / Adapter</span>
              <h2>运行适配器</h2>
              <p>可替换的运行时连接，当前为演示模式。</p>
            </div>
            <MonoTag>演示模式</MonoTag>
          </div>
          <div className="vq-card-body">
            <div className="vq-row">
              <div className="vq-row-copy">
                <strong>DSH Adapter</strong>
                <span>mode: mock · 未连接真实模型</span>
              </div>
              <span className="vq-row-value vq-mono">v0.1</span>
            </div>
            <div className="capability-list">
              <Capability label="流式输出" value="支持" />
              <Capability label="结构化输出" value="支持" />
              <Capability label="工具调用" value="待接入" />
              <Capability label="真实模型连接" value="未配置" />
            </div>
            <p className="vq-note">
              <ShieldCheck size={12} />
              <span>密钥只留在服务端；前端不持有任何凭据。</span>
            </p>
          </div>
        </section>

        <section className="vq-card">
          <div className="vq-card-head">
            <div>
              <span className="vq-mono">Preferences</span>
              <h2>工作区偏好</h2>
            </div>
          </div>
          <div className="vq-card-body">
            <div className="vq-row">
              <div className="vq-row-copy">
                <strong>默认输出语言</strong>
                <span>影响智能体的初始回复</span>
              </div>
              <button
                type="button"
                className="vq-button vq-button--ghost"
                onClick={() => setLanguage((value) => (value === 'zh' ? 'en' : 'zh'))}
              >
                {language === 'zh' ? '简体中文' : 'English'}
                <ChevronDown size={13} />
              </button>
            </div>
            <div className="vq-row">
              <div className="vq-row-copy">
                <strong>自动保存草稿</strong>
                <span>编辑后 3 秒保存一次（演示）</span>
              </div>
              <button
                type="button"
                className={`vq-switch${autoSave ? ' is-on' : ''}`}
                aria-pressed={autoSave}
                aria-label={autoSave ? '关闭自动保存' : '开启自动保存'}
                onClick={() => setAutoSave((value) => !value)}
              />
            </div>
            <div className="vq-row">
              <div className="vq-row-copy">
                <strong>运行完成提醒</strong>
                <span>仅在有新产物时提醒</span>
              </div>
              <button
                type="button"
                className={`vq-switch${runNotify ? ' is-on' : ''}`}
                aria-pressed={runNotify}
                aria-label={runNotify ? '关闭运行完成提醒' : '开启运行完成提醒'}
                onClick={() => setRunNotify((value) => !value)}
              />
            </div>
          </div>
        </section>
      </div>

      <footer className="vq-settings-foot">
        <span>账号会话由服务端校验；设置项只保存在当前浏览器。</span>
        <span className="vq-mono">VisionQA · v0.1.0</span>
      </footer>
    </div>
  )
}
