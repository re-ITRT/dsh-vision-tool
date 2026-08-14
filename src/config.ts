import Schema from '@deepseek-ai/schemastery'

/**
 * 视觉调用的提示词模板。执行 vision_analyze 时，把 {question} 替换成模型传入的
 * question 参数，然后与图片一起发给所选视觉模型（与需求方给定的提示词一致）。
 */
export const DEFAULT_PROMPT_TEMPLATE =
  'Fully describe and explain everything about this image, then answer the following question:\n\n{question}'

/** dsh-vision-tool 的组合配置（cordis.yml 的 config 段）。 */
export interface Config {
  /**
   * 组合层默认视觉提供方路由（设置页里选择的 provider 会覆盖它）。
   * 视觉调用直接复用该路由，端点和密钥由「模型」页管理。
   */
  provider?: string
  /** 组合层默认视觉模型 id（设置页里选择的 model 会覆盖它）。 */
  model?: string
  /** 设置命名空间，默认 'vision'。 */
  namespace?: string
  /** 图像最长边像素上限，超出则等比缩小；region 先裁剪、后缩小。默认 1568。 */
  maxDimension?: number
  /** JPEG 编码质量（0-100），默认 90。 */
  jpegQuality?: number
  /** 辅助视觉模型调用使用的 system prompt。 */
  systemPrompt?: string
  /** 视觉调用提示词模板，{question} 占位符会被替换。 */
  promptTemplate?: string
}

/** 同名的 Schemastery schema：Cordis 加载时用它校验并填充默认值。 */
export const Config: Schema<Config> = Schema.object({
  provider: Schema.string(),
  model: Schema.string(),
  namespace: Schema.string().default('vision'),
  maxDimension: Schema.number().default(1568),
  jpegQuality: Schema.number().default(90),
  systemPrompt: Schema.string().default(
    'You are a precise visual analysis assistant. Answer only based on what you can see in the image.',
  ),
  promptTemplate: Schema.string().default(DEFAULT_PROMPT_TEMPLATE),
})
