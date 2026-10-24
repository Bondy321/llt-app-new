import { defineConfig, loadEnv } from 'vite'
import process from 'node:process'
import { adminBuildPolicy } from './buildConfig.js'
import react from '@vitejs/plugin-react'
import packageJson from './package.json' with { type: 'json' }

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const policy = adminBuildPolicy({ command, mode, environment: { ...loadEnv(mode, process.cwd(), ''), ...process.env } });
  return {
  plugins: [react(), {
    name: 'admin-production-app-check-boundary',
    configResolved(config) {
      if (command === 'build' && mode === 'verification' && config.build.outDir !== 'verification-dist') {
        throw new Error('Verification output must stay in verification-dist; it cannot produce deployable dist.');
      }
    },
  }],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  build: {
    outDir: policy.outDir,
    commonjsOptions: {
      include: [/node_modules/, /utils\/unifiedSyncContract\.js/],
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/firebase/') || id.includes('/@firebase/')) return 'firebase-vendor';
          if (id.includes('/@mantine/')) return 'mantine-vendor';
          if (id.includes('/@tabler/')) return 'icons-vendor';
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/react-router')) return 'react-vendor';
          return undefined;
        },
      },
    },
  },
  server: {
    headers: {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  },
  };
})
