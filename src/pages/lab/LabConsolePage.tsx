import type { LabSection } from '../../editions'
import { DiagnosticsSection } from './DiagnosticsSection'
import { FixturesSection } from './FixturesSection'
import { FlagsSection } from './FlagsSection'
import { HealthSection } from './HealthSection'
import { useConsoleCapture } from './consoleStore'
import '../../styles/lab.css'

export type { LabSection }

const SECTIONS: Record<LabSection, { label: string; mono: string; hint: string }> = {
  health: {
    label: '接口体检',
    mono: 'HEALTH',
    hint: '并发探测工作台依赖的 8 个接口，显示状态码、耗时与关键字段；失败不兜底。',
  },
  fixtures: {
    label: '样例对照',
    mono: 'FIXTURES',
    hint: '把 src/data/mock.ts 的示例数据与当前接口返回摆在一起，明确哪些是真实、哪些只是样例。',
  },
  flags: {
    label: '功能开关',
    mono: 'FLAGS',
    hint: '本机 localStorage 的功能开关；每条都标明当前是否真的被代码读取。',
  },
  diagnostics: {
    label: '诊断导出',
    mono: 'DIAGNOSTICS',
    hint: '版本、浏览器、本地服务与控制台记录，一键导出为本地 JSON，便于复现问题。',
  },
}

export default function LabConsolePage({ section }: { section: LabSection }) {
  const logs = useConsoleCapture()
  const meta = SECTIONS[section] ?? SECTIONS.health

  return (
    <div className="lab-page">
      <header className="lab-head">
        <div className="lab-head-copy">
          <div className="lab-kicker">
            <span>LAB CONSOLE</span>
            <em>/</em>
            <span>内测测试版</span>
          </div>
          <h1>{meta.label}</h1>
          <p>{meta.hint}</p>
        </div>
        <div className="lab-head-side">
          <span className="lab-chip lab-chip--ink">{meta.mono}</span>
          <span className="lab-chip lab-chip--quiet">{section === 'flags' ? '仅本机写入' : '只读探测'}</span>
          <span className="lab-mono">console {logs.length}/20</span>
        </div>
      </header>

      {section === 'health' && <HealthSection />}
      {section === 'fixtures' && <FixturesSection />}
      {section === 'flags' && <FlagsSection />}
      {section === 'diagnostics' && <DiagnosticsSection />}

      <footer className="lab-page-foot">
        <span>VisionQA Lab · 内测测试版</span>
        <span className="lab-mono">REAL REQUESTS / REAL BROWSER APIS · NO FABRICATION</span>
      </footer>
    </div>
  )
}