import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // Allows the VS Code / dev-tunnel URL you share with friends. Development only:
    // production serves the built files from Express, not from this dev server.
    allowedHosts: true,
    // The browser only ever talks to this origin; /api is forwarded to the Express server.
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        // Keep the browser's original Host header so the API's same-origin (CSRF) check
        // can compare it with the Origin header - this is what makes a shared dev-tunnel
        // URL work without adding it to ALLOWED_ORIGINS.
        changeOrigin: false,
      },
    },
  },
});
