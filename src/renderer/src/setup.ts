import { createMockBridge } from './mock'

// Outside Electron (npm run dev:ui) there is no backend, so use a fake one.
// Imported first in main.tsx so `window.bridge` exists before any other module reads it.
if (!window.bridge) window.bridge = createMockBridge()
