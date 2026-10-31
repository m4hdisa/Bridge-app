// Runs only the UI in a normal browser with a fake backend (src/renderer/src/mock.ts).
// Handy for working on the design without starting Electron or the VPN core.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: 'src/renderer',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': resolve(__dirname, 'src/renderer/src') } },
  server: { port: 5199, strictPort: true }
})
