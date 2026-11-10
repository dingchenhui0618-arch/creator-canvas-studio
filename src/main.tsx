import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './index.css'
import './styles/tokens.css'
import './styles/legacy-fix.css'
import App from './App.tsx'
// 放在 App 之后：保证外壳补充规则晚于 App.css / shell.css / overview.css 生效。
import './styles/nav.css'
import { readInitialEdition } from './editions'
import { initializeRoute } from './router'

// 首屏先把地址栏规范化：空 hash 用 replaceState 补成 #/overview（或后台总览），不新增历史记录。
initializeRoute(readInitialEdition())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
