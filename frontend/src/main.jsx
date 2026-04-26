import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import './index.css'
// Global styles — imported at the entry point so every route (including
// /result/:taskId on a cold open) gets the design tokens, shared classes,
// and Tailwind utilities without depending on HostStudio having mounted.
// Previously these imports sat inside HostStudio.jsx, which made the result
// page a blank-styled wasteland on direct navigation. (Codex #6.)
import './studio/styles/tokens.css'
import './studio/styles/app.css'
import './studio/styles/tailwind.css'
// Side-effect import: registers the auth-header provider with http.ts and
// the 401/403 redirect handler. Must run before any fetchJSON call.
import './stores/authStore'
import App from './App'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
    <Toaster
      position="top-right"
      richColors
      closeButton
      toastOptions={{
        className: 'font-sans',
        style: {
          fontFamily: 'var(--font-sans)',
          fontSize: '13px',
          letterSpacing: '-0.012em',
        },
      }}
    />
  </StrictMode>,
)
