import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
    environment: 'jsdom',
    setupFiles: './src/test/setupTests.js',
    testTimeout: 15000,
  },
})
