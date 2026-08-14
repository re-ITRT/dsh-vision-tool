import Schema from '@deepseek-ai/schemastery'
import { settingsNamespace, type SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'

/**
 * 设置命名空间 'vision' 的用户可编辑分节：从「模型」页已有的提供方里
 * 选择一个 provider + model 作为视觉模型。端点和密钥由提供方自己的配置负责，
 * 视觉页只做选择 —— 和官方「模型」页的配置方式一致。
 */
export interface VisionSettings {
  /**
   * 视觉辅助总开关。关闭时插件整体失效，行为与未安装插件完全一致
   * （无视觉模型收到图片会走 DSH 默认的「该模型无视觉功能」拒绝）。
   * 开启后：无视觉主模型的消息图片会在 pre-step 被自动转成视觉模型的
   * 文字描述；vision_analyze 工具注册，agent 可自行决定调用。
   */
  enabled: boolean
  /** 视觉提供方路由 id（如 opencode-go / deepseek-official）。 */
  provider: string
  /** 视觉模型 id（如 qwen-vl-max / gpt-4o-mini）。 */
  model: string
}

export const VisionSettingsSchema: Schema<VisionSettings> = Schema.object({
  enabled: Schema.boolean().default(false),
  provider: Schema.string().default(''),
  model: Schema.string().default(''),
})

/** llm-pi-ai 适配器的设置命名空间：图片能力声明写进 providers.<provider>.modelOverrides。 */
const PI_AI_NS = settingsNamespace('llm-pi-ai')

export function visionNamespace(config: Config) {
  return settingsNamespace(config.namespace ?? 'vision')
}

/**
 * 判定「已配置」：总开关开启 且 provider 与 model 都已选择。
 * 只有已配置时 vision_analyze 才会注册进工具注册表（以及 pre-step 图片拦截
 * 才会挂载），否则 agent 上下文里看不到它、消息图片也走 DSH 默认行为。
 */
export function isVisionConfigured(settings: VisionSettings): boolean {
  return settings.enabled && Boolean(settings.provider.trim() && settings.model.trim())
}

/**
 * 把「该模型接受图片输入」的声明同步进 llm-pi-ai 命名空间。
 *
 * OpenAI 兼容路由默认按纯文本对待模型，给视觉模型附加图片会在发送前被拒绝；
 * 官方「配置模型」指南给出的办法是在 profile 里写 input: ['text', 'image']。
 * 这里把指南里的手写声明自动化：
 * - pi-ai 目录路由（declared === false，如 opencode-go / qwen / zai …）：
 *   写 providers.<provider>.modelOverrides.<model>.input = ['text', 'image']
 *   （目录模型没有 models 列表，modelOverrides 正是给这类路由用的；模型 id
 *   必须在该路由目录里，否则 pi-ai 会拒绝写入 —— 记日志即可）。
 * - pi-ai 自建路由（declared === true）：modelOverrides 不被接受，声明必须
 *   写进该路由自己的 models 列表条目 —— path op 无法定位数组元素，跳过并提示。
 * - 其它适配器（如纯文本的 DeepSeek 官方路由）：本身无法接收图片，跳过。
 * 切换选择时会把上一次写过的声明清理掉。
 */
export async function syncImageInputDeclaration(
  ctx: Context,
  settings: VisionSettings,
  previous: VisionSettings | undefined,
): Promise<void> {
  const provider = settings.provider.trim()
  const model = settings.model.trim()

  const piAiEntry = ctx.llm.listConfigurableProviders().find(
    (entry) => entry.settingsNs === 'llm-pi-ai' && entry.provider === provider,
  )

  // 清理上一次的声明（选择变化或清空时；只清理目录路由的 modelOverrides）
  const prevProvider = previous?.provider.trim()
  const prevModel = previous?.model.trim()
  if (prevProvider && prevModel && (prevProvider !== provider || prevModel !== model)) {
    const prevEntry = ctx.llm.listConfigurableProviders().find(
      (entry) => entry.settingsNs === 'llm-pi-ai' && entry.provider === prevProvider,
    )
    if (prevEntry !== undefined && prevEntry.declared === false) {
      const ops: readonly SettingsPathOp[] = [
        { op: 'unset', path: ['providers', prevProvider, 'modelOverrides', prevModel, 'input'] },
      ]
      await ctx.settings.mutate(PI_AI_NS, ops).catch((error: unknown) => {
        ctx.logger.warn('[dsh-vision-tool] failed to clear previous image-input declaration: ' + (error as Error).message)
      })
    }
  }

  if (!provider || !model) return
  if (piAiEntry === undefined) {
    ctx.logger.warn(
      '[dsh-vision-tool] provider "' + provider + '" is not an llm-pi-ai route; ' +
        'skipping the image-input declaration — 该路由的模型很可能无法接收图片输入',
    )
    return
  }
  if (piAiEntry.declared !== false) {
    ctx.logger.warn(
      '[dsh-vision-tool] provider "' + provider + '" is a hand-declared route; ' +
        'its models are spelled out in the route\'s own models list — ' +
        '请在该路由的模型条目上声明 input: [text, image]（可用「模型」页或 settings.yaml）',
    )
    return
  }
  const ops: readonly SettingsPathOp[] = [
    { op: 'set', path: ['providers', provider, 'modelOverrides', model, 'input'], value: ['text', 'image'] },
  ]
  await ctx.settings.mutate(PI_AI_NS, ops).catch((error: unknown) => {
    ctx.logger.warn('[dsh-vision-tool] image-input declaration failed: ' + (error as Error).message)
  })
}
