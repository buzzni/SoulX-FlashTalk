import { BrowserRouter, Routes, Route } from 'react-router-dom';
import HostStudio from './studio/HostStudio.jsx'
import ResultPage from './studio/ResultPage.tsx'
import ErrorBoundary from './studio/ErrorBoundary.jsx'

// Router:
//   /                    — wizard + live render dashboard (HostStudio)
//   /result/:taskId      — dedicated completed-task view (ResultPage)
// Queue polling lives inside queueStore (Phase 2a) — no Provider needed;
// the store reference-counts subscribers and owns the interval/abort
// lifecycle itself. This means the poll continues across route changes
// and only runs while at least one consumer is mounted.
export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<HostStudio />} />
          <Route path="/result/:taskId" element={<ResultPage />} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  )
}
