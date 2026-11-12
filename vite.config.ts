import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const apiTarget = process.env.API_TARGET || 'http://127.0.0.1:8787'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5191,
    strictPort: true,
    proxy: {
      // Host 保持 127.0.0.1:5191：服务端的同源校验拿 Origin 和 Host 比，
      // 改成目标端口会让登录这类写请求被判成「来源不被信任」（桌面壳里走同一个代理）。
      '/api': { target: apiTarget },
      '/media': { target: apiTarget, changeOrigin: true },
    },
  },
})
