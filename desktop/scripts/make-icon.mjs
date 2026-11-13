#!/usr/bin/env node
/**
 * 生成 macOS 应用图标（assets/icon.icns），零依赖。
 *
 * 为什么不用 Chrome/SVG：本机不保证有完整 Xcode，也不想多一个渲染依赖。
 * 这里直接用 SDF 栅格化 + 手写 PNG 编码（Node 自带 zlib），再交给系统 iconutil 打包。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktop = path.resolve(here, '..')
const assets = path.join(desktop, 'assets')
const S = 1024
const SS = 2 // 超采样倍数（2x2 = 4 个样本/像素）

// ─────────────────────────────── 几何

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

/** 点到线段距离 */
function segDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax
  const aby = by - ay
  const apx = px - ax
  const apy = py - ay
  const t = clamp((apx * abx + apy * aby) / (abx * abx + aby * aby || 1), 0, 1)
  const dx = px - (ax + abx * t)
  const dy = py - (ay + aby * t)
  return Math.hypot(dx, dy)
}

/** 圆角矩形（squircle 近似）：返回带符号距离，内部为负 */
function roundRectDist(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const hx = (x1 - x0) / 2 - r
  const hy = (y1 - y0) / 2 - r
  const qx = Math.abs(px - cx) - hx
  const qy = Math.abs(py - cy) - hy
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r
}

// 图形：满幅留 8% 边距
const PAD = 78
const X0 = PAD
const Y0 = PAD
const X1 = S - PAD
const Y1 = S - PAD
const RADIUS = 196

// 两条箭头（坐标基于 1024 画布）
const ARROWS = [
  {
    // 上：向右
    alpha: 0.96,
    shaft: [276, 418, 726, 418],
    head: [
      [800, 418, 716, 334],
      [800, 418, 716, 502],
    ],
  },
  {
    // 下：向左
    alpha: 0.74,
    shaft: [748, 606, 298, 606],
    head: [
      [224, 606, 308, 522],
      [224, 606, 308, 690],
    ],
  },
]
const ARROW_R = 30

function sample(px, py) {
  // 背景圆角矩形
  const d = roundRectDist(px, py, X0, Y0, X1, Y1, RADIUS)
  if (d > 0) return [0, 0, 0, 0]

  // 对角渐变 #6d8cff → #35d4bf
  const t = clamp((px + py - (X0 + Y0)) / (X1 + Y1 - X0 - Y0), 0, 1)
  let r = 109 + (53 - 109) * t
  let g = 140 + (212 - 140) * t
  let b = 255 + (191 - 255) * t
  let a = 255

  // 箭头（白色，叠在渐变上）
  for (const arrow of ARROWS) {
    const [sx0, sy0, sx1, sy1] = arrow.shaft
    let hit = segDist(px, py, sx0, sy0, sx1, sy1) <= ARROW_R
    if (!hit) {
      for (const [ax, ay, bx, by] of arrow.head) {
        if (segDist(px, py, ax, ay, bx, by) <= ARROW_R) {
          hit = true
          break
        }
      }
    }
    if (hit) {
      const k = arrow.alpha
      r = r * (1 - k) + 255 * k
      g = g * (1 - k) + 255 * k
      b = b * (1 - k) + 255 * k
    }
  }

  // 边缘 1px 抗锯齿由超采样负责，这里不做额外处理
  return [r, g, b, a]
}

function renderBase() {
  const buf = Buffer.alloc(S * S * 4)
  const step = 1 / SS
  const n = SS * SS
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [sr, sg, sb, sa] = sample(x + (sx + 0.5) * step, y + (sy + 0.5) * step)
          const af = sa / 255
          r += sr * af
          g += sg * af
          b += sb * af
          a += sa
        }
      }
      const af = a / (255 * n)
      const i = (y * S + x) * 4
      buf[i] = Math.round(af ? r / (n * af) : 0)
      buf[i + 1] = Math.round(af ? g / (n * af) : 0)
      buf[i + 2] = Math.round(af ? b / (n * af) : 0)
      buf[i + 3] = Math.round(a / n)
    }
  }
  return buf
}

// ─────────────────────────────── PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 面积平均缩放（1024 → size），保证小图标不发糊 */
function resize(rgba, size) {
  const out = Buffer.alloc(size * size * 4)
  const ratio = S / size
  for (let y = 0; y < size; y++) {
    const sy0 = Math.floor(y * ratio)
    const sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * ratio))
    for (let x = 0; x < size; x++) {
      const sx0 = Math.floor(x * ratio)
      const sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * ratio))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = sy0; sy < sy1 && sy < S; sy++) {
        for (let sx = sx0; sx < sx1 && sx < S; sx++) {
          const i = (sy * S + sx) * 4
          const af = rgba[i + 3] / 255
          r += rgba[i] * af
          g += rgba[i + 1] * af
          b += rgba[i + 2] * af
          a += rgba[i + 3]
          n++
        }
      }
      const af = n ? a / (255 * n) : 0
      const o = (y * size + x) * 4
      out[o] = Math.round(af ? r / (n * af) : 0)
      out[o + 1] = Math.round(af ? g / (n * af) : 0)
      out[o + 2] = Math.round(af ? b / (n * af) : 0)
      out[o + 3] = Math.round(n ? a / n : 0)
    }
  }
  return out
}

// ─────────────────────────────── 主流程

const ICONSET = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]

console.log(`栅格化 ${S}×${S}（${SS}× 超采样）…`)
const base = renderBase()

const iconset = path.join(assets, 'icon.iconset')
fs.rmSync(iconset, { recursive: true, force: true })
fs.mkdirSync(iconset, { recursive: true })

const cache = new Map()
for (const [name, size] of ICONSET) {
  if (!cache.has(size)) cache.set(size, size === S ? base : resize(base, size))
  fs.writeFileSync(path.join(iconset, name), encodePng(cache.get(size), size))
}
console.log(`已生成 ${ICONSET.length} 张 PNG`)
// 留一张 512 预览，方便肉眼检查（构建时不影响 icns）
fs.writeFileSync(path.join(assets, 'icon-512.png'), encodePng(cache.get(512), 512))

const out = path.join(assets, 'icon.icns')
const r = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', out], { stdio: 'inherit' })
if (r.status !== 0) {
  // 本机 iconutil 偶发拒收手写 PNG；已有可用 icns 时继续构建，不挡打包
  if (fs.existsSync(out) && fs.statSync(out).size > 1024) {
    console.warn(`iconutil 失败，沿用已有 ${out}（${(fs.statSync(out).size / 1024).toFixed(0)} KB）`)
  } else {
    console.error('iconutil 失败且没有可用的 icon.icns —— 图标已生成在 assets/icon.iconset，可手工转 icns')
    process.exit(1)
  }
} else {
  fs.rmSync(iconset, { recursive: true, force: true })
  console.log(`✅ ${out}（${(fs.statSync(out).size / 1024).toFixed(0)} KB）`)
}

// ─────────────────────────────── ICO（Windows）
// Vista+ 支持 ICO 内直接放 PNG，所以不必写 BMP 编码。
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

function encodeIco(items) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(items.length, 4)

  const entries = Buffer.alloc(16 * items.length)
  let offset = 6 + 16 * items.length
  items.forEach(({ size, png }, i) => {
    const o = i * 16
    entries[o] = size >= 256 ? 0 : size // 0 表示 256
    entries[o + 1] = size >= 256 ? 0 : size
    entries[o + 2] = 0 // palette
    entries[o + 3] = 0 // reserved
    entries.writeUInt16LE(1, o + 4) // planes
    entries.writeUInt16LE(32, o + 6) // bpp
    entries.writeUInt32LE(png.length, o + 8)
    entries.writeUInt32LE(offset, o + 12)
    offset += png.length
  })

  return Buffer.concat([header, entries, ...items.map((x) => x.png)])
}

const icoItems = ICO_SIZES.map((size) => {
  if (!cache.has(size)) cache.set(size, resize(base, size))
  return { size, png: encodePng(cache.get(size), size) }
})
const icoPath = path.join(assets, 'icon.ico')
fs.writeFileSync(icoPath, encodeIco(icoItems))
console.log(`✅ ${icoPath}（${(fs.statSync(icoPath).size / 1024).toFixed(0)} KB）`)
