import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative base so the Electron build can load dist/index.html from disk.
  base: './',
  server: { port: 5173, strictPort: true },
})
