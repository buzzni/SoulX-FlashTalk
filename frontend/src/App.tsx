/**
 * Route tree.
 *
 *   /                    → redirects to /step/<deepest-reachable>
 *   /step/1|2|3          → wizard steps; layout owns prev/next/reset
 *   /render              → dispatch-new; replaces URL to /render/:id
 *                          once task_id lands
 *   /render/:taskId      → attach-mode (live queue row + SSE)
 *   /result/:taskId      → frozen manifest view
 *
 * Queue polling lives inside queueStore — the store refcount-gates
 * subscribers and owns the interval/abort lifecycle. The poll continues
 * across route changes and only runs while at least one consumer is
 * mounted, so no Provider hoisting is needed here.
 */
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import ErrorBoundary from './studio/ErrorBoundary.jsx';
import ResultPage from './studio/ResultPage';
import WizardLayout from './routes/WizardLayout';
import { Step1Page, Step2Page, Step3Page } from './routes/StepPages';
import { RenderDispatchPage, RenderAttachPage } from './routes/RenderPage';
import { RootRedirect } from './routes/RootRedirect';

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route
            path="/step/1"
            element={
              <WizardLayout>
                <Step1Page />
              </WizardLayout>
            }
          />
          <Route
            path="/step/2"
            element={
              <WizardLayout>
                <Step2Page />
              </WizardLayout>
            }
          />
          <Route
            path="/step/3"
            element={
              <WizardLayout>
                <Step3Page />
              </WizardLayout>
            }
          />
          <Route path="/render" element={<RenderDispatchPage />} />
          <Route path="/render/:taskId" element={<RenderAttachPage />} />
          <Route path="/result/:taskId" element={<ResultPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
