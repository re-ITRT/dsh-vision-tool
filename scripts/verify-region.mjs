// region 裁剪实测：1000x800 图 → crop [100,150,600,400] → 期望 500x250；越界 clamp 验证
import sharp from 'sharp'
import { loadImage } from '../lib/image.js'

// 生成测试图
const src = await sharp({ create: { width: 1000, height: 800, channels: 3, background: { r: 200, g: 100, b: 50 } } })
  .png().toBuffer()
const dataUrl = 'data:image/png;base64,' + src.toString('base64')

const r1 = await loadImage(dataUrl, [100, 150, 600, 400], new AbortController().signal, { maxDimension: 1568, jpegQuality: 90 })
console.log('crop [100,150,600,400]:', r1.width + 'x' + r1.height, 'expect 500x250', r1.mediaType)

const r2 = await loadImage(dataUrl, [-50, -20, 2000, 900], new AbortController().signal, { maxDimension: 1568, jpegQuality: 90 })
console.log('clamp [-50,-20,2000,900]:', r2.width + 'x' + r2.height, 'expect 1000x800')

try {
  const r3 = await loadImage(dataUrl, [500, 0, 500, 100], new AbortController().signal, { maxDimension: 1568, jpegQuality: 90 })
  console.log('degenerate [500,0,500,100]:', r3.width + 'x' + r3.height, 'expect error/empty')
} catch (e) {
  console.log('degenerate [500,0,500,100]: threw as expected —', e.message)
}
