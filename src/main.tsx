import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './index.css'
import './styles/tokens.css'
import './styles/legacy-fix.css'
import App from './App.tsx'
// 放在 App 之后：保证外壳补充规则晚于 App.css / shell.css / overview.css 生效。
import './styles/nav.css'
// 动效细则层（r319）：列表逐条进场、卡片抬起、提示条滑入，以及 reduce-motion 总闸。
// 放在最后：它只补动效，不改布局；前面的样式表仍然是布局的真源。
import './styles/motion.css'
import { readInitialEdition } from './editions'
import { readSession } from './auth/session'
import { initializeRoute } from './router'
import { installClientErrorReporting } from './lib/clientErrors'
import { installChunkReloadGuard } from './lib/chunkReload'

// 首屏先把地址栏规范化：空 hash 用 replaceState 补成 #/overview（或后台总览），不新增历史记录。
// 先拿本地缓存里的角色只为选对首屏落点，避免管理员刷新时闪一下用户版；真正的角色由 /api/auth/me
// 在 App 里再校验，普通账号即使缓存被改成 admin 也会被 App 的门禁挡住（接口另有 403）。
initializeRoute(readInitialEdition(readSession()?.user.kind === 'admin'))

// 早于 render 装上：首屏渲染就炸的情况也要能报到服务端
installClientErrorReporting()

// 发版后旧标签页点进懒加载页会取不到旧文件：撞上就自动重载一次（同一次发版最多两次）。
installChunkReloadGuard()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
