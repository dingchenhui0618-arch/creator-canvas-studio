import { useState } from 'react'
import { DEMO_EMAIL, DEMO_NAME, readSession, sessionKindLabel } from '../../auth/session'
import { formatDateTime } from './data'
import { AdminHead, SourceTag } from './ui'

export default function UsersSection() {
  const [session] = useState(() => readSession())
  const matched = session && session.user.email === DEMO_EMAIL ? session : null

  return (
    <>
      <AdminHead
        kicker="ADMIN / USERS"
        title="演示账号"
        description="账号已写入服务端数据库（data/auth.db），但这页还没接管理员用户列表接口：下面只展示当前会话，不虚构其他用户。"
        actions={<SourceTag kind="local" source="src/auth/session.ts" />}
      />

      <section className="admin-card admin-block">
        <div className="admin-block-head">
          <div>
            <p className="admin-label">本地用户</p>
            <p className="admin-sub">共 1 个演示账号；访客会话不算账号。</p>
          </div>
          <button
            type="button"
            className="admin-btn admin-btn--primary"
            disabled
            title="src/auth/session.ts 没有导出 addUser / register，无法在本地新增账号；接入后端用户表后开放。"
          >
            新建演示账号
          </button>
        </div>

        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>标识</th>
                <th>显示名</th>
                <th>角色</th>
                <th>最近登录</th>
                <th>会话存储</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="admin-mono">{DEMO_EMAIL}</td>
                <td>{DEMO_NAME}</td>
                <td>{sessionKindLabel('demo')}（本地）</td>
                <td>{matched ? formatDateTime(matched.signedInAt) : '—（当前未登录）'}</td>
                <td className="admin-mono">{matched ? 'visionqa.session.v1' : '—'}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <p className="admin-hint">
          按钮保持禁用是因为 session.ts 只提供登录/退出，没有新增账号的导出；这里不伪造可用的「新建」入口。
        </p>
      </section>

      <section className="admin-note">
        <p>字段来源</p>
        <ul>
          <li>标识 / 显示名：<code>DEMO_EMAIL</code>、<code>DEMO_NAME</code> 常量。</li>
          <li>角色：<code>SessionKind</code> 的 demo 类型，经 <code>sessionKindLabel</code> 输出。</li>
          <li>最近登录：<code>readSession()</code> 的当前会话 <code>signedInAt</code>；没有会话时显示占位。</li>
        </ul>
      </section>
    </>
  )
}
