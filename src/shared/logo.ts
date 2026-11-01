// Bridge's logo geometry, shared by the app (SVG) and scripts/make-icon.ts (the PNG app icon),
// so the window, the sidebar and the installer show the same mark.

/** The connect button's shield, in a 100 x 120 box centred on (50, 60): flat-topped, pointed at the bottom. */
export const SHIELD_PATH = 'M50 4 L88.5 17.6 Q93 19.2 93 24 V55 Q93 86 52.6 115.2 Q50 117 47.4 115.2 Q7 86 7 55 V24 Q7 19.2 11.5 17.6 Z'

/** The brand blue: the logo's tile, and the app's primary color. */
export const LOGO_COLOR = '#023ee8'

/** The logo: a rounded tile in a 100 x 100 box. */
export const LOGO_TILE = 'M22 0 H78 Q100 0 100 22 V78 Q100 100 78 100 H22 Q0 100 0 78 V22 Q0 0 22 0 Z'

/**
 * The white bridge on the tile (the designed mark, traced from its 1024 px artwork): a deck with
 * two pillars standing through it, and six circles cut out of it, which round off the shape
 * into an arch between the pillars below and scallops above and at the sides.
 * Rectangles are [x1, y1, x2, y2].
 */
export const BRIDGE_RECTS: [number, number, number, number][] = [
  [24, 29.5, 76, 55.9],
  [34.7, 55.9, 39.2, 70.3],
  [60.8, 55.9, 65.3, 70.3]
]
export const BRIDGE_HOLE_R = 10.7
export const BRIDGE_HOLES: [number, number][] = [24, 50, 76].flatMap((x): [number, number][] => [
  [x, 29.5],
  [x, 55.9]
])
