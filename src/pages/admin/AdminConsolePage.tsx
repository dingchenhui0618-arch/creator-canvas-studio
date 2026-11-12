import '../../styles/console.css'
import type { AdminSection } from '../../editions'
import AuditSection from './AuditSection'
import CanvasSection from './CanvasSection'
import KeysSection from './KeysSection'
import OverviewSection from './OverviewSection'
import SystemSection from './SystemSection'
import ReportsSection from './ReportsSection'
import TemplatesSection from './TemplatesSection'
import UsersSection from './UsersSection'

export default function AdminConsolePage({ section }: { section: AdminSection }) {
  return (
    <div className="admin-page">
      {section === 'overview' ? <OverviewSection /> : null}
      {section === 'users' ? <UsersSection /> : null}
      {section === 'canvas' ? <CanvasSection /> : null}
      {section === 'keys' ? <KeysSection /> : null}
      {section === 'templates' ? <TemplatesSection /> : null}
      {section === 'reports' ? <ReportsSection /> : null}
      {section === 'audit' ? <AuditSection /> : null}
      {section === 'system' ? <SystemSection /> : null}
    </div>
  )
}
