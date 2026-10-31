// Generates a placeholder app icon (resources/icon.png, 256x256): a blue circle with a white bridge arch.
// Replace resources/icon.png with a real design later.
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 256
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'icon.png')

const px = Buffer.alloc(SIZE * SIZE * 4)
const c = SIZE / 2
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4
    const d = Math.hypot(x + 0.5 - c, y + 0.5 - c)
    const alpha = Math.max(0, Math.min(1, c - 4 - d)) // anti-aliased circle edge
    // Arch: ring segment in the upper half plus a deck line.
    const ad = Math.hypot(x + 0.5 - c, y + 0.5 - (c + 40))
    const arch = ad > 62 && ad < 80 && y < c + 40
    const deck = y > c + 26 && y < c + 42 && Math.abs(x - c) < 92
    const white = (arch || deck) && d < c - 14
    px[i] = white ? 255 : 79
    px[i + 1] = white ? 255 : 124
    px[i + 2] = 255
    px[i + 3] = Math.round(alpha * 255)
  }
}

function crc32(buf) {
  let crc = ~0
  for (const b of buf) {
    crc ^= b
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}
function chunk(type, data) {
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
writeFileSync(
  out,
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
)
console.log(`icon -> ${out}`)
