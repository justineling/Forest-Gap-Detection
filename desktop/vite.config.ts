import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Tauri 桌面端会把 dist/ 作为 WebView 的静态资源；开发期直接用浏览器调试。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    // maplibre-gl 单包就 ~800 KB，属预期，别让警告淹没真正的体积问题
    chunkSizeWarningLimit: 1500,
  },
})
