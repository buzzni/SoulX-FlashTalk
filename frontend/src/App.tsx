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
import ResultPage from './studio/ResultPage';
import WizardLayout from './routes/WizardLayout';
import { Step1Page, Step2Page, Step3Page } from './routes/StepPages';
import { RenderDispatchPage, RenderAttachPage } from './routes/RenderPage';
import LoginPage from './routes/LoginPage';
import { RequireAuth } from './routes/RequireAuth';
import { HomePage } from './routes/HomePage';
import { MyPage } from './routes/MyPage';
import { ResultsListPage } from './routes/ResultsListPage';

export default function App() {
  // The top-level ErrorBoundary moved to main.jsx (Lane A) so the
  // <QueryClientProvider> is also available inside the fallback. Per-
  // step boundaries live in routes/StepPages.tsx (Lane G) and reset
  // on wizardEpoch change.
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<RequireAuth><HomePage /></RequireAuth>} />
        <Route path="/mypage" element={<RequireAuth><MyPage /></RequireAuth>} />
        <Route path="/results" element={<RequireAuth><ResultsListPage /></RequireAuth>} />
        <Route
          path="/step/1"
          element={
            <RequireAuth>
              <WizardLayout>
                <Step1Page />
              </WizardLayout>
            </RequireAuth>
          }
        />
        <Route
          path="/step/2"
          element={
            <RequireAuth>
              <WizardLayout>
                <Step2Page />
              </WizardLayout>
            </RequireAuth>
          }
        />
        <Route
          path="/step/3"
          element={
            <RequireAuth>
              <WizardLayout>
                <Step3Page />
              </WizardLayout>
            </RequireAuth>
          }
        />
        <Route path="/render" element={<RequireAuth><RenderDispatchPage /></RequireAuth>} />
        <Route path="/render/:taskId" element={<RequireAuth><RenderAttachPage /></RequireAuth>} />
        <Route path="/result/:taskId" element={<RequireAuth><ResultPage /></RequireAuth>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
