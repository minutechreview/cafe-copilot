import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Local dev only: proxies chat requests to agent/dev-server.mjs so the browser never
// needs to know the backend's port or deal with CORS during development.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/chat': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
