import { BrowserRouter, Routes, Route } from 'react-router-dom';
import HostStudio from './studio/HostStudio.jsx'
import ResultPage from './studio/ResultPage.jsx'
import ErrorBoundary from './studio/ErrorBoundary.jsx'
import { QueueProvider } from './studio/QueueContext.jsx'

// Router:
//   /                    — wizard + live render dashboard (HostStudio)
//   /result/:taskId      — dedicated completed-task view (ResultPage)
// QueueProvider is hoisted above <Routes> so the 4s queue polling survives
// navigation between the two — QueueStatus renders on both pages.
export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <QueueProvider>
          <Routes>
            <Route path="/" element={<HostStudio />} />
            <Route path="/result/:taskId" element={<ResultPage />} />
          </Routes>
        </QueueProvider>
      </BrowserRouter>
    </ErrorBoundary>
  )
}
