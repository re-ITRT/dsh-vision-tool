import Schema from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { settingsNamespace, type SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { Context } from '@deepseek-ai/cordis'
import { isVisionConfigured, declareImageInputForMainModel, undeclareMainModelImages, type VisionSettings } from './settings.js'

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

/** ensureImageAdmission 的输入：提交图片消息的会话。 */
export interface VisionAdmissionRequest {
  sessionId: string
}

/** ensureImageAdmission 的返回值。 */
export interface VisionAdmissionResult {
  /**
   * 视觉辅助已配置且主模型声明成功 → true：图片消息会被 apiproxy 放行，
   * 由 pre-step 拦截器替换成占位文本，agent 通过 vision_analyze 查看。
   * false：保持 DSH 默认行为（无视觉模型收到图片消息被拒绝，与原版一致）。
   */
  allowed: boolean
  /** 是否实际为主模型写了图片声明（非 pi-ai 路由时为 false）。 */
  patched: boolean
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
    // 关闭开关：撤销为主模型写过的图片声明，避免残留误报
    if (!next.enabled) {
      await undeclareMainModelImages(this.ctx).catch((error: unknown) => {
        this.ctx.logger.warn('[dsh-vision-tool] failed to clear main-model declarations: ' + (error as Error).message)
      })
    }
    return this.describe(signal)
  }

  /**
   * 提交前放行检查（用户直传图片路径）：
   * 视觉辅助开启时，给当前会话的主模型写 pi-ai modelOverrides 图片声明，
   * 让 apiproxy 的图片门禁放行 —— 图片以 image block 进入会话历史/UI，
   * pre-step 拦截器再把它替换成占位文本，内容获取由 agent 调 vision_analyze
   * 完成（tool call 架构，与 Hermes 一致）。
   * 未配置（开关关）或主模型非 pi-ai 路由时返回 allowed:false，
   * 调用方原样提交，行为与未安装插件一致（DSH 默认拒绝无视觉模型的图片）。
   */
  @Remote
  async ensureImageAdmission(request: VisionAdmissionRequest, signal: AbortSignal): Promise<VisionAdmissionResult> {
    const settings = this.resolve()
    if (!isVisionConfigured(settings)) {
      return { allowed: false, patched: false }
    }
    const sessionId = request?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { allowed: false, patched: false }
    }
    const agents = this.ctx.get('agents')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- branded SessionId 与 wire 字符串互转
    const agent = agents?.get(sessionId as any)
    const header = agent?.session?.requestHeader?.()
    const selection = header?.config
    if (!selection?.provider || !selection?.model) {
      return { allowed: false, patched: false }
    }
    const patched = await declareImageInputForMainModel(this.ctx, selection.provider, selection.model)
    return { allowed: patched, patched }
  }
}
