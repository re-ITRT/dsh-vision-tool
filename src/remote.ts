import Schema from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { settingsNamespace, type SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { Context } from '@deepseek-ai/cordis'
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

/** vision/describe 与 vision/save 的返回值：当前选择 + 供下拉框使用的模型目录。 */
export interface VisionDescribeResult {
  provider: string
  model: string
  configured: boolean
  groups: VisionCatalogGroup[]
  failures: VisionCatalogFailure[]
}

export interface VisionSaveRequest {
  provider: string
  model: string
}

/** Remote 服务的插件配置：设置命名空间。 */
export interface VisionRemoteConfig {
  namespace: string
}

export const VisionRemoteConfig: Schema<VisionRemoteConfig> = Schema.object({
  namespace: Schema.string().default('vision'),
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
  static inject = ['settings', 'llm']

  private readonly ns: ReturnType<typeof settingsNamespace>

  constructor(ctx: Context, config: VisionRemoteConfig) {
    super(ctx, 'vision')
    this.ns = settingsNamespace(config.namespace ?? 'vision')
  }

  private get settings(): SettingsProvider {
    return this.ctx.settings
  }

  private resolve(): VisionSettings {
    const value = this.settings.get(this.ns)
    if (typeof value !== 'object' || value === null) return { provider: '', model: '' }
    const candidate = value as Partial<VisionSettings>
    return {
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
      provider: settings.provider,
      model: settings.model,
      configured: isVisionConfigured(settings),
      groups,
      failures,
    }
  }

  /** 保存视觉模型选择（provider + model），返回保存后的完整状态。 */
  @Remote
  async save(request: VisionSaveRequest, signal: AbortSignal): Promise<VisionDescribeResult> {
    const provider = typeof request?.provider === 'string' ? request.provider.trim() : ''
    const model = typeof request?.model === 'string' ? request.model.trim() : ''
    if (!provider || !model) {
      throw new Error('vision/save: provider and model must be non-empty')
    }
    await this.settings.update(this.ns, { provider, model })
    return this.describe(signal)
  }
}
