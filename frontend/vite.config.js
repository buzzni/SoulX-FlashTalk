import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Vite dev-server proxies /api and /static to the FastAPI backend on
// 127.0.0.1:8001. This keeps the backend bound to loopback (per plan §4.0.3
// D13) while still letting remote browsers that reach Vite via the network
// IP (e.g., 172.28.60.60:5555) make API calls — the calls go back through
// the Vite process, not directly to the user's machine.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8001',
        changeOrigin: true,
        // Don't auto-upgrade to WS for /api — uvicorn returns HTTP/1.1 and ws:true
        // can race with a streaming POST body on slow remote clients, leaving the
        // response stuck in the proxy.
        ws: false,
        timeout: 120000,
        proxyTimeout: 120000,
        configure: (proxy) => {
          proxy.on('error', (err, req, res) => {
            console.error('[vite-proxy] error', req.method, req.url, err.message);
            if (res && !res.headersSent) {
              res.writeHead(502, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ detail: `proxy error: ${err.message}` }));
            }
          });
          proxy.on('proxyReq', (proxyReq, req) => {
            console.log('[vite-proxy] →', req.method, req.url, 'len=', req.headers['content-length'] || '?');
          });
          proxy.on('proxyRes', (proxyRes, req, res) => {
            console.log('[vite-proxy] ←', req.method, req.url, 'status=', proxyRes.statusCode, 'len=', proxyRes.headers['content-length'] || '?');
            // SSE streams need to flush per-chunk. Without the Nagle/keep-
            // alive tuning the default pipe buffers body chunks until either
            // the backend fills the socket buffer or the stream closes —
            // which made /api/progress/{id} return 200 headers but the
            // browser's EventSource never saw any `data:` frames while the
            // worker was still running.
            //
            // Do NOT call res.flushHeaders() here: at proxyRes-event time
            // http-proxy hasn't copied Content-Type (and other headers) from
            // proxyRes to res yet, so flushing pre-empts the copy and the
            // response reaches the browser without `Content-Type: text/
            // event-stream` — EventSource then silently rejects every frame.
            const ct = proxyRes.headers['content-type'] || '';
            if (ct.includes('text/event-stream')) {
              proxyRes.headers['x-accel-buffering'] = 'no';
              proxyRes.headers['cache-control'] = 'no-cache';
              res.socket?.setNoDelay?.(true);
              res.socket?.setKeepAlive?.(true);
              proxyRes.socket?.setNoDelay?.(true);
              proxyRes.socket?.setKeepAlive?.(true);
            }
          });
        },
      },
      '/static': {
        target: 'http://127.0.0.1:8001',
        changeOrigin: true,
      },
    },
  },
})
