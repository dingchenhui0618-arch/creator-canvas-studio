// 站点公示（v0.9.67）：备案号、运营主体、地址、信用代码、客服邮箱、投诉渠道。
// 为什么做在后台：这些值随主体与备案变化，填一次就该立刻出现在页脚、登录页、条款与隐私说明里，
// 不该为改一个邮箱发一版。没填的项就不显示，页面不摆空壳，也不写「待填」占位。
import { useState } from 'react'
import { request } from '../../api/client'
import { useApi } from './data'
import { Badge, LoadingLine, SourceTag } from './ui'

type SiteInfo = {
  icp: string
  operator: string
  address: string
  creditCode: string
  supportEmail: string
  complaint: string
  source: 'admin' | 'env' | 'none'
  complete: boolean
  missing: string[]
  updatedAt: string
  updatedBy: string
}

type SiteField = {
  key: keyof Omit<SiteInfo, 'source' | 'complete' | 'missing' | 'updatedAt' | 'updatedBy'>
  label: string
  max: number
  required: boolean
  hint: string
}

type SiteResponse = { ok: boolean; site: SiteInfo; fields: SiteField[] }

const EMPTY: Record<string, string> = { icp: '', operator: '', address: '', creditCode: '', supportEmail: '', complaint: '' }

export default function SiteInfoCard() {
  const { data, error, loading, reload } = useApi<SiteResponse>('/api/admin/site')
  // 表单值不从接口「灌」进 state（那要在 effect 里 setState）：没动过就直接用接口值，
  // 一动手就是草稿，保存 / 清空后丢掉草稿、回到接口值。
  const [draft, setDraft] = useState<Record<string, string> | null>(null)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')

  const stored = data?.site
  const form: Record<string, string> = draft ?? (stored
    ? {
        icp: stored.icp,
        operator: stored.operator,
        address: stored.address,
        creditCode: stored.creditCode,
        supportEmail: stored.supportEmail,
        complaint: stored.complaint,
      }
    : EMPTY)

  const setField = (key: string, value: string) => setDraft({ ...form, [key]: value })

  const save = async () => {
    setBusy('save')
    setNote('')
    try {
      const result = await request<SiteResponse>('/api/admin/site', { method: 'PUT', body: JSON.stringify(form) })
      setDraft(null)
      setNote(
        result.site.complete
          ? '已保存：备案号、主体与客服邮箱齐了，页脚、登录页、条款与隐私说明会立刻显示。'
          : '已保存。还缺：' + (result.site.missing.join('、') || '无'),
      )
      reload()
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      setBusy('')
    }
  }

  const clear = async () => {
    setBusy('clear')
    setNote('')
    try {
      await request<SiteResponse>('/api/admin/site', { method: 'DELETE' })
      setDraft(null)
      setNote('已清空后台填写的内容；如果环境变量里配了 VQ_ICP / VQ_SUPPORT_EMAIL，会继续用它们。')
      reload()
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : '清空失败')
    } finally {
      setBusy('')
    }
  }

  const site = data?.site
  return (
    <section className="admin-card admin-block admin-block--site">
      <div className="admin-block-head">
        <div>
          <p className="admin-label">站点公示</p>
          <p className="admin-sub">
            页脚、登录页、条款与隐私说明共用的对外信息。填完立刻生效，不用改环境变量、不用重启；没填的项不显示，页面不摆空壳。
          </p>
        </div>
        <div className="admin-alert-actions">
          <SourceTag kind="api" source="GET /api/admin/site" />
          {site ? (
            <Badge tone={site.complete ? 'ok' : site.source === 'none' ? 'warn' : 'neutral'}>
              {site.complete ? '已齐' : site.source === 'none' ? '未填' : '还缺 ' + site.missing.length}
            </Badge>
          ) : null}
        </div>
      </div>

      {loading && !site ? <LoadingLine label="/api/admin/site" /> : null}
      {error ? <p className="admin-hint">读取失败：{error}</p> : null}

      {site ? (
        <>
          <dl className="admin-kv">
            <div>
              <dt>当前来源</dt>
              <dd>
                <Badge tone={site.source === 'admin' ? 'ok' : site.source === 'env' ? 'neutral' : 'warn'}>
                  {site.source === 'admin' ? '后台填写' : site.source === 'env' ? '环境变量' : '未配置'}
                </Badge>
                {site.updatedAt ? <span className="admin-cell-sub">更新于 {site.updatedAt.slice(0, 16).replace('T', ' ')}（UTC）{site.updatedBy ? ' · ' + site.updatedBy : ''}</span> : null}
              </dd>
            </div>
            <div>
              <dt>会展示在</dt>
              <dd>
                <span className="admin-cell-sub">工作台页脚、登录页、服务条款、隐私说明、帮助中心；客服邮箱同时用于「忘记密码」页的求助提示。</span>
              </dd>
            </div>
          </dl>

          <div className="admin-site-form">
            {(data?.fields || []).map((field) => (
              <label className={'vq-field admin-site-field' + (field.key === 'address' ? ' admin-site-field--wide' : '')} key={field.key}>
                <span>
                  {field.label}
                  {field.required ? '' : '（选填）'}
                </span>
                <input
                  className="vq-input"
                  value={form[field.key] || ''}
                  onChange={(event) => setField(field.key, event.target.value)}
                  placeholder={field.hint}
                  maxLength={field.max}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy === 'save'}
                />
              </label>
            ))}
          </div>

          {note ? <p className="admin-hint">{note}</p> : null}

          <div className="admin-doc-actions">
            <button type="button" className="vq-button" onClick={() => void save()} disabled={busy === 'save'}>
              {busy === 'save' ? '保存中…' : '保存公示信息'}
            </button>
            <button type="button" className="vq-button vq-button--ghost" onClick={() => void clear()} disabled={busy === 'clear' || site.source !== 'admin'}>
              {busy === 'clear' ? '清空中…' : '清空后台填写'}
            </button>
          </div>
        </>
      ) : null}
    </section>
  )
}
