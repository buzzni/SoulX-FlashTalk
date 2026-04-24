import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// Global styles — imported at the entry point so every route (including
// /result/:taskId on a cold open) gets the design tokens, shared classes,
// and Tailwind utilities without depending on HostStudio having mounted.
// Previously these imports sat inside HostStudio.jsx, which made the result
// page a blank-styled wasteland on direct navigation. (Codex #6.)
import './studio/styles/tokens.css'
import './studio/styles/app.css'
import './studio/styles/tailwind.css'
import App from './App'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
