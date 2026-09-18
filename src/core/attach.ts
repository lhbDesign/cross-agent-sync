import fs from 'node:fs'
import path from 'node:path'
import type { ImagePart } from '../types'
import { ATTACH_DIR } from '../config'
import { extForMediaType } from '../util'

/**
 * 把会话里的 base64 图片落盘，返回文件路径。
 * 新 agent 拿到路径就能直接看图（不需要用户重新粘贴）。
 */
export function saveImages(images: ImagePart[], key: string, dir: string = ATTACH_DIR, startIndex = 1): string[] {
  const safe = key.replace(/[^a-zA-Z0-9._-]+/g, '_')
  const target = path.join(dir, safe)
  fs.mkdirSync(target, { recursive: true })
  const out: string[] = []
  images.forEach((img, i) => {
    // 本来就在磁盘上的（Cursor 的附件）：直接用原路径，不必复制一份
    if (!img.base64 && img.path) {
      if (fs.existsSync(img.path)) out.push(img.path)
      return
    }
    if (!img.base64) return
    const ext = extForMediaType(img.mediaType)
    const file = path.join(target, `img-${startIndex + i}.${ext}`)
    try {
      fs.writeFileSync(file, Buffer.from(img.base64, 'base64'))
      out.push(file)
    } catch {
      /* 单张失败不影响其它 */
    }
  })
  return out
}

export function toDataUrl(img: ImagePart): string {
  if (img.base64) return `data:${img.mediaType};base64,${img.base64}`
  if (img.path) return `data:${img.mediaType};base64,${fs.readFileSync(img.path).toString('base64')}`
  return ''
}
