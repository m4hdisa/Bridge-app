// Draws the app icon (resources/icon.png, 256 x 256) from the logo geometry in src/shared/logo.ts:
// the white bridge mark on the brand-blue tile, on a transparent background. Shapes are
// sampled 4 x 4 per pixel for smooth edges. Usage: npx tsx scripts/make-icon.ts
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { BRIDGE_HOLE_R, BRIDGE_HOLES, BRIDGE_RECTS, LOGO_COLOR, LOGO_TILE } from '../src/shared/logo'

const SIZE = 256
const SAMPLES = 4
const out = join(__dirname, '..', 'resources', 'icon.png')

// The 100 x 100 logo box, scaled to fill the icon with a small margin.
const scale = (SIZE * 0.94) / 100
const offX = (SIZE - 100 * scale) / 2
const offY = offX

/** Flattens a path (M, L, Q, V, H, Z only) into points in logo units. */
function polygon(d: string): [number, number][] {
  const t = d.match(/[MLQVHZ]|-?\d*\.?\d+/g)!
  const pts: [number, number][] = []
  let i = 0
  let x = 0
  let y = 0
  const num = () => Number(t[i++])
  while (i < t.length) {
    const c = t[i++]
    if (c === 'M' || c === 'L') pts.push([(x = num()), (y = num())])
    else if (c === 'V') pts.push([x, (y = num())])
    else if (c === 'H') pts.push([(x = num()), y])
    else if (c === 'Q') {
      const [qx, qy, ex, ey] = [num(), num(), num(), num()]
      for (let k = 1; k <= 16; k++) {
        const s = k / 16
        pts.push([(1 - s) ** 2 * x + 2 * (1 - s) * s * qx + s * s * ex, (1 - s) ** 2 * y + 2 * (1 - s) * s * qy + s * s * ey])
      }
      x = ex
      y = ey
    }
  }
  return pts
}
const tile = polygon(LOGO_TILE)

function inTile(px: number, py: number): boolean {
  let inside = false
  for (let a = 0, b = tile.length - 1; a < tile.length; b = a++) {
    const [xa, ya] = tile[a]
    const [xb, yb] = tile[b]
    if (ya > py !== yb > py && px < ((xb - xa) * (py - ya)) / (yb - ya) + xa) inside = !inside
  }
  return inside
}

/** The bridge: inside one of its rectangles and outside every cut-out circle. */
function inBridge(px: number, py: number): boolean {
  const inRect = BRIDGE_RECTS.some(([x1, y1, x2, y2]) => px >= x1 && px <= x2 && py >= y1 && py <= y2)
  return inRect && !BRIDGE_HOLES.some(([cx, cy]) => Math.hypot(px - cx, py - cy) < BRIDGE_HOLE_R)
}

const rgb = (hex: string) => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16))
const tileColor = rgb(LOGO_COLOR)

const px = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let cover = 0
    let white = 0
    for (let sy = 0; sy < SAMPLES; sy++) {
      for (let sx = 0; sx < SAMPLES; sx++) {
        const lx = (x + (sx + 0.5) / SAMPLES - offX) / scale
        const ly = (y + (sy + 0.5) / SAMPLES - offY) / scale
        if (!inTile(lx, ly)) continue
        cover++
        if (inBridge(lx, ly)) white++
      }
    }
    const n = SAMPLES * SAMPLES
    if (!cover) continue
    const w = white / cover
    const i = (y * SIZE + x) * 4
    for (let c = 0; c < 3; c++) px[i + c] = Math.round(tileColor[c] + (255 - tileColor[c]) * w)
    px[i + 3] = Math.round((cover / n) * 255)
  }
}

function crc32(buf: Buffer): number {
  let crc = ~0
  for (const b of buf) {
    crc ^= b
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
writeFileSync(out, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
console.log(`wrote ${out}`)
