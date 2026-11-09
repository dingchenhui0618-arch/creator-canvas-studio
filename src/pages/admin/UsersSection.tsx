import { useState } from 'react'
import { sessionKindLabel, readSession } from '../../auth/session'
import { formatDateTime } from './data'
import { AdminHead, SourceTag } from './ui'

/**
 * 账号页如实说明现状：账号已落库，但服务端还没有管理员用户列表接口，
 * 所以这里只展示当前会话，不摆示例用户、也不给假的分页。
 */
export default function UsersSection() {
  const [session] = useState(() => readSession())

  return (
    <>
      <AdminHead
        kicker="ADMIN / USERS"
        title="账号"
        description="账号存在服务端数据库（data/auth.db，SQLite）。管理员用户列表接口还没做，这一页只显示当前会话，不虚构其他用户。"
        actions={<SourceTag kind="local" source="data/auth.db" />}
      />

      <section className="admin-card admin-block">
        <div className="admin-block-head">
          <div>
            <p className="admin-label">当前会话</p>
            <p className="admin-sub">来自 /api/auth/me 校验过的浏览器缓存；角色由服务端 users.kind 决定。</p>
          </div>
        </div>

        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>邮箱</th>
                <th>显示名</th>
                <th>角色</th>
                <th>工作区</th>
                <th>本次登录</th>
              </tr>
            </thead>
            <tbody>
              {session ? (
                <tr>
                  <td className="admin-mono">{session.user.email}</td>
                  <td>{session.user.name}</td>
                  <td>{sessionKindLabel(session.user.kind)}</td>
                  <td>{session.user.workspace}</td>
                  <td className="admin-mono">{formatDateTime(session.signedInAt)}</td>
                </tr>
              ) : (
                <tr>
                  <td colSpan={5} className="admin-cell-sub">
                    当前浏览器没有会话。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="admin-hint">
          新增账号目前只有一条路：在服务端执行 <code>npm run adduser</code>（见 README「账号」一节）。页面上不放点了没反应的
          「新建账号」按钮。
        </p>
      </section>

      <section className="admin-note">
        <p>要做完整用户管理，需要补这三样</p>
        <ul>
          <li>服务端：<code>GET /api/admin/users</code>（分页、关键字、状态筛选）。</li>
          <li>服务端：禁用 / 重置口令接口，写审计日志。</li>
          <li>前端：本页换成表格 + 行内操作，权限判断放在服务端。</li>
        </ul>
      </section>
    </>
  )
}
