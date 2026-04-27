import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import { ErrorBoundary } from 'react-error-boundary'
import { QueryClientProvider } from '@tanstack/react-query'
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
import { queryClient } from './api/query-client'
import { TopLevelErrorFallback } from './components/error-fallback'

// Devtools imported lazily so they never reach the production bundle.
// `import.meta.env.DEV` is statically replaced at build time → tree-shaken.
const ReactQueryDevtools = import.meta.env.DEV
  ? lazy(() =>
      import('@tanstack/react-query-devtools').then((m) => ({
        default: m.ReactQueryDevtools,
      })),
    )
  : null

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary FallbackComponent={TopLevelErrorFallback}>
      <QueryClientProvider client={queryClient}>
        <App />
        {ReactQueryDevtools && (
          <Suspense fallback={null}>
            <ReactQueryDevtools initialIsOpen={false} />
          </Suspense>
        )}
      </QueryClientProvider>
    </ErrorBoundary>
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
