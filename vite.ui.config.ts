// Runs only the UI in a normal browser with a fake backend (src/renderer/src/mock.ts).
// Handy for working on the design without starting Electron or the VPN core.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  server: { port: 5199, strictPort: true }
})
