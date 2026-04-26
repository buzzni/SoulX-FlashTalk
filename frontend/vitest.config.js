import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Vitest reads its own config and does NOT inherit `vite.config.js`,
// so the `@/` path alias must be redeclared here. Without it, every
// test file that imports `@/components/...` (or `@/wizard/...`) fails
// at collection with "Failed to resolve import".
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // e2e/ is Playwright's turf — its specs use browser APIs and
    // `@playwright/test`, which vitest would choke on.
    exclude: ['node_modules/**', 'dist/**', 'e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 50,
        statements: 60,
      },
      include: ['src/studio/**'],
      exclude: ['**/__tests__/**', '**/*.test.*'],
    },
  },
})
