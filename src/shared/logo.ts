// Bridge's logo geometry, shared by the app (SVG) and scripts/make-icon.ts (the PNG app icon),
// so the window, the sidebar and the installer show the same mark.

/** The connect button's shield, in a 100 x 120 box centred on (50, 60): flat-topped, pointed at the bottom. */
export const SHIELD_PATH = 'M50 4 L88.5 17.6 Q93 19.2 93 24 V55 Q93 86 52.6 115.2 Q50 117 47.4 115.2 Q7 86 7 55 V24 Q7 19.2 11.5 17.6 Z'

/** The logo: a rounded blue tile in a 100 x 100 box. */
export const LOGO_TILE = 'M22 0 H78 Q100 0 100 22 V78 Q100 100 78 100 H22 Q0 100 0 78 V22 Q0 0 22 0 Z'

/**
 * A plain arch bridge on the tile, as round-capped white strokes: an arch over the deck, with
 * three hangers between them. Only M / L / Q / V / H commands, so make-icon can draw them too.
 */
const ARCH = { x1: 22, x2: 78, y: 63, peak: 14 }
/** The arch's height at `x` (a quadratic curve from one end of the deck to the other). */
function archY(x: number): number {
  const t = (x - ARCH.x1) / (ARCH.x2 - ARCH.x1)
  return (1 - t) ** 2 * ARCH.y + 2 * (1 - t) * t * ARCH.peak + t * t * ARCH.y
}
export const BRIDGE_PATHS = [
  'M14 63 H86',
  `M${ARCH.x1} ${ARCH.y} Q50 ${ARCH.peak} ${ARCH.x2} ${ARCH.y}`,
  ...[36, 50, 64].map((x) => `M${x} ${archY(x).toFixed(1)} V${ARCH.y}`)
]
export const BRIDGE_STROKE = 6.5

/** The tile's fill, top to bottom (sRGB, for the PNG; the SVG uses the same colors). */
export const LOGO_TOP = '#5b9bff'
export const LOGO_BOTTOM = '#2453d6'
