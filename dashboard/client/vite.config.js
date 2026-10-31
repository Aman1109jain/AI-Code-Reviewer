import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxies /api calls to the Express server during local dev
// (server.js listens on PORT, default 3000)
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
