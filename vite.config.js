import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Proxy API calls to the Node sync server on :3001 during development.
export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/api': {
        target: process.env.SYNC_TARGET || 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
