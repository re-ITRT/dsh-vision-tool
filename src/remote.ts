import Schema from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { settingsNamespace, type SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { Context } from '@deepseek-ai/cordis'
import { describeAttachments, type ImageInterceptDeps } from './intercept.js'
import { isVisionConfigured, type VisionSettings } from './settings.js'

/** 视觉页下拉框里的一组模型（对应官方模型目录的 provider group）。 */
export interface VisionCatalogModel {
  id: string
  name: string
  description?: string
  /** 该模型当前是否声明了 image 输入模态（选中后可自动声明，见 syncImageInputDeclaration）。 */
  vision: boolean
}

export interface VisionCatalogGroup {
  id: string
  name: string
  models: VisionCatalogModel[]
}

export interface VisionCatalogFailure {
  id: string
  name: string
  message: string
}

/** vision/describe 与 vision/save 的返回值：开关状态 + 当前选择 + 供下拉框使用的模型目录。 */
export interface VisionDescribeResult {
  /** 视觉辅助总开关。 */
  enabled: boolean
  provider: string
  model: string
  configured: boolean
  groups: VisionCatalogGroup[]
  failures: VisionCatalogFailure[]
}

export interface VisionSaveRequest {
  /** 视觉辅助总开关（可选：仅切换开关时传，不触碰模型选择）。 */
  enabled?: boolean
  provider?: string
  model?: string
}

/** transformImages 的输入：浏览器提交前的一张图片（base64 直传）。 */
export interface VisionImagePart {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  data: string
  name?: string
}

/** transformImages 的返回值：开关状态 + 每张图的描述文字。 */
export interface VisionTransformResult {
  /** 视觉辅助是否开启；关闭时 descriptions 为空数组，调用方保持原样提交。 */
  enabled: boolean
  descriptions: string[]
}

/** Remote 服务的插件配置：设置命名空间 + 提示词模板（供 transformImages 复用）。 */
export interface VisionRemoteConfig {
  namespace: string
  /** 视觉调用提示词模板，{question} 占位符会被替换（默认见 config.ts）。 */
  promptTemplate?: string
  /** 辅助视觉模型调用使用的 system prompt。 */
  systemPrompt?: string
}

export const VisionRemoteConfig: Schema<VisionRemoteConfig> = Schema.object({
  namespace: Schema.string().default('vision'),
  promptTemplate: Schema.string(),
  systemPrompt: Schema.string(),
})

const VISION_NS = settingsNamespace('vision')

/**
 * 插件自有的 Typert Remote 命名空间 'vision'（方法端点为 vision/describe、
 * vision/save），经 /api 通道暴露给 Web 设置页。
 *
 * 之所以不用 settings 命名空间：dsh-host-apiproxy 对设置命名空间有白名单，
 * 只有注册成 configurable provider 的命名空间才对配置客户端可见，而那会
 * 让「模型」页多出一行。Remote 是插件自己拥有的 API 面，host 侧直接读写
 * 设置服务，与白名单无关。
 */
export class VisionRemoteService extends TypertRemoteService {
  static inject = ['settings', 'llm', 'attachments']

  private readonly ns: ReturnType<typeof settingsNamespace>
  private readonly promptTemplate: string | undefined
  private readonly systemPrompt: string | undefined

  constructor(ctx: Context, config: VisionRemoteConfig) {
    super(ctx, 'vision')
    this.ns = settingsNamespace(config.namespace ?? 'vision')
    this.promptTemplate = config.promptTemplate
    this.systemPrompt = config.systemPrompt
  }

  private get settings(): SettingsProvider {
    return this.ctx.settings
  }

  private resolve(): VisionSettings {
    const value = this.settings.get(this.ns)
    if (typeof value !== 'object' || value === null) return { enabled: false, provider: '', model: '' }
    const candidate = value as Partial<VisionSettings>
    return {
      enabled: candidate.enabled === true,
      provider: typeof candidate.provider === 'string' ? candidate.provider : '',
      model: typeof candidate.model === 'string' ? candidate.model : '',
    }
  }

  /** 当前选择 + 全部已注册路由的模型目录（每个模型带 vision 能力标记）。 */
  @Remote
  async describe(signal: AbortSignal): Promise<VisionDescribeResult> {
    const settings = this.resolve()
    const groups: VisionCatalogGroup[] = []
    const failures: VisionCatalogFailure[] = []
    const providers = this.ctx.llm.listProviders()
    await Promise.all(providers.map(async (info) => {
      try {
        const models = await this.ctx.llm.listModels(info.id)
        const items = await Promise.all(models.map(async (model) => {
          let vision = false
          try {
            const resolved = await this.ctx.llm.resolveModelInfo(info.id, model.id, signal)
            vision = resolved.inputModalities?.includes('image') ?? false
          } catch {
            // 目录未描述的模型：能力未知，选中后由 syncImageInputDeclaration 尝试声明
          }
          return {
            id: model.id,
            name: model.name,
            ...(model.description === void 0 ? {} : { description: model.description }),
            vision,
          } satisfies VisionCatalogModel
        }))
        groups.push({ id: info.id, name: info.name, models: items })
      } catch (error) {
        failures.push({ id: info.id, name: info.name, message: (error as Error).message })
      }
    }))
    return {
      enabled: settings.enabled,
      provider: settings.provider,
      model: settings.model,
      configured: isVisionConfigured(settings),
      groups,
      failures,
    }
  }

  /** 保存视觉辅助配置：可只切开关（enabled），也可同时选模型（provider + model）。 */
  @Remote
  async save(request: VisionSaveRequest, signal: AbortSignal): Promise<VisionDescribeResult> {
    const current = this.resolve()
    const next: VisionSettings = {
      enabled: request?.enabled === undefined ? current.enabled : request.enabled === true,
      provider: typeof request?.provider === 'string' ? request.provider.trim() : current.provider,
      model: typeof request?.model === 'string' ? request.model.trim() : current.model,
    }
    if (!next.provider || !next.model) {
      throw new Error('vision/save: provider and model must be non-empty')
    }
    await this.settings.update(this.ns, next)
    return this.describe(signal)
  }

  /**
   * 提交前图片转换：浏览器把待发送的图片（base64）交给宿主，视觉辅助开启时
   * 逐张用所选视觉模型生成文字描述。关闭时返回 enabled:false，调用方保持原样。
   * 图片先落附件服务（与 read_image 同一持久化通道），描述复用拦截器逻辑。
   */
  @Remote
  async transformImages(request: { images: VisionImagePart[] }, signal: AbortSignal): Promise<VisionTransformResult> {
    const settings = this.resolve()
    if (!isVisionConfigured(settings) || !Array.isArray(request?.images) || request.images.length === 0) {
      return { enabled: false, descriptions: [] }
    }
    const deps: ImageInterceptDeps = {
      ctx: this.ctx,
      config: {
        ...(this.promptTemplate === undefined ? {} : { promptTemplate: this.promptTemplate }),
        ...(this.systemPrompt === undefined ? {} : { systemPrompt: this.systemPrompt }),
      },
      getSettings: () => this.resolve(),
    }
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) {
      throw new Error('vision/transformImages: attachment service unavailable')
    }
    try {
      // saveImage 返回完整 ImageAttachmentRef（bytes/width/height 等），
      // 必须原样传给描述调用 —— adapter 序列化 image block 时要读这些字段。
      const refs = await Promise.all(request.images.map(async (part) => {
        const data = Uint8Array.from(atob(part.data), char => char.charCodeAt(0))
        return attachments.saveImage({
          data,
          mediaType: part.mediaType,
          ...(part.name === undefined ? {} : { name: part.name }),
        })
      }))
      const descriptions = await describeAttachments(deps, refs, signal)
      if (descriptions === undefined) {
        throw new Error('vision/transformImages: vision model call failed')
      }
      return { enabled: true, descriptions }
    } catch (error) {
      this.ctx.logger.warn('[dsh-vision-tool] transformImages failed: %s', (error as Error).message)
      throw error
    }
  }
}
