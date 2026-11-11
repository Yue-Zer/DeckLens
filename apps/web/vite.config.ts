import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { env } from 'node:process'

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': `http://127.0.0.1:${Number(env.DECKLENS_PORT || 4173)}`,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
