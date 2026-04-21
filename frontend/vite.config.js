import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite dev-server proxies /api and /static to the FastAPI backend on
// 127.0.0.1:8001. This keeps the backend bound to loopback (per plan §4.0.3
// D13) while still letting remote browsers that reach Vite via the network
// IP (e.g., 172.28.60.60:5555) make API calls — the calls go back through
// the Vite process, not directly to the user's machine.
export default defineConfig({
  plugins: [react()],
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
          proxy.on('proxyRes', (proxyRes, req) => {
            console.log('[vite-proxy] ←', req.method, req.url, 'status=', proxyRes.statusCode, 'len=', proxyRes.headers['content-length'] || '?');
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
