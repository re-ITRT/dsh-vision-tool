import { readFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

/** DSH 附件服务接受的光栅媒体类型（gif 会转码成 png）。 */
export type LoadedMediaType = 'image/png' | 'image/jpeg' | 'image/webp'

export interface LoadedImage {
  data: Uint8Array
  mediaType: LoadedMediaType
  width: number
  height: number
  name?: string
}

export interface ImagePipelineOptions {
  /** 最长边像素上限；超出则等比缩小（在 region 裁剪之后应用）。 */
  maxDimension: number
  /** JPEG 质量。 */
  jpegQuality: number
}

const DATA_URL_RE = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/

/**
 * 把 image_url 参数解析成编码后的图片字节：
 * - data: URL —— 直接解码；
 * - http(s) URL —— fetch 下载；
 * - 其它 —— 按本地文件路径读取（相对路径相对进程工作目录）。
 * 然后应用可选的 [x1, y1, x2, y2] 裁剪（坐标 clamp 到原图边界，先裁剪），
 * 再对超出 maxDimension 的结果等比缩小。
 */
export async function loadImage(
  input: string,
  region: number[] | undefined,
  signal: AbortSignal,
  options: ImagePipelineOptions,
): Promise<LoadedImage> {
  const trimmed = input.trim()
  let buffer: Buffer
  let name: string | undefined

  const dataUrl = DATA_URL_RE.exec(trimmed)
  if (dataUrl) {
    buffer = Buffer.from(dataUrl[2].replace(/\s/g, ''), 'base64')
    name = 'image'
  } else if (/^https?:\/\//i.test(trimmed)) {
    const response = await fetch(trimmed, { signal })
    if (!response.ok) {
      throw new Error(
        'vision_analyze: failed to download image from ' + trimmed + ': HTTP ' + response.status,
      )
    }
    buffer = Buffer.from(await response.arrayBuffer())
    try {
      const segment = new URL(trimmed).pathname.split('/').pop()
      name = segment ? decodeURIComponent(segment) || 'image' : 'image'
    } catch {
      name = 'image'
    }
  } else {
    const filePath = path.resolve(trimmed)
    buffer = await readFile(filePath)
    name = path.basename(filePath) || 'image'
  }

  const meta = await sharp(buffer, { failOn: 'none' }).metadata()
  if (!meta.width || !meta.height) {
    throw new Error('vision_analyze: cannot decode image dimensions')
  }
  return {
    ...(await processImage(buffer, meta.format, region, options)),
    name,
  }
}

/**
 * 对已解码的图片字节应用 region 裁剪（先裁剪后缩小，坐标 clamp 到原图边界）
 * 与 maxDimension 等比缩小，再按格式家族重新编码。供 loadImage 与附件
 * 引用（attachment://）路径共用。
 */
export async function processImage(
  buffer: Buffer,
  format: string | undefined,
  region: number[] | undefined,
  options: ImagePipelineOptions,
): Promise<Omit<LoadedImage, 'name'>> {
  const meta = await sharp(buffer, { failOn: 'none' }).metadata()
  if (!meta.width || !meta.height) {
    throw new Error('vision_analyze: cannot decode image dimensions')
  }

  let pipeline: ReturnType<typeof sharp> = sharp(buffer, { failOn: 'none' })
  let outWidth = meta.width
  let outHeight = meta.height

  // region 裁剪：先于任何缩小，坐标 clamp 到原图边界
  if (region !== undefined) {
    if (region.length !== 4 || region.some((v) => !Number.isFinite(v))) {
      throw new Error('vision_analyze: region must be exactly 4 integers [x1, y1, x2, y2]')
    }
    const x1 = clamp(Math.trunc(region[0]), 0, meta.width)
    const y1 = clamp(Math.trunc(region[1]), 0, meta.height)
    const x2 = clamp(Math.trunc(region[2]), 0, meta.width)
    const y2 = clamp(Math.trunc(region[3]), 0, meta.height)
    const width = x2 - x1
    const height = y2 - y1
    if (width <= 0 || height <= 0) {
      throw new Error(
        'vision_analyze: region is empty after clamping (' + [x1, y1, x2, y2].join(', ') + ')',
      )
    }
    pipeline = pipeline.extract({ left: x1, top: y1, width, height })
    outWidth = width
    outHeight = height
  }

  // 缩小：region 保持全分辨率，除非裁剪结果本身仍超过上限
  if (Math.max(outWidth, outHeight) > options.maxDimension) {
    pipeline = pipeline.resize({
      width: options.maxDimension,
      height: options.maxDimension,
      fit: 'inside',
      withoutEnlargement: true,
    })
  }

  // 编码：保持原格式家族；gif 等其它格式统一转 png
  let mediaType: LoadedMediaType
  if (format === 'jpeg') {
    mediaType = 'image/jpeg'
    pipeline = pipeline.jpeg({ quality: options.jpegQuality })
  } else if (format === 'webp') {
    mediaType = 'image/webp'
    pipeline = pipeline.webp()
  } else {
    mediaType = 'image/png'
    pipeline = pipeline.png()
  }

  const data = await pipeline.toBuffer()
  const outMeta = await sharp(data).metadata()
  return {
    data: new Uint8Array(data),
    mediaType,
    width: outMeta.width ?? outWidth,
    height: outMeta.height ?? outHeight,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}
