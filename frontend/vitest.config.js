import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
