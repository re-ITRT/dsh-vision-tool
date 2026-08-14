import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.js'
import { VisionRemoteService } from './remote.js'
import {
  VisionSettingsSchema,
  isVisionConfigured,
  syncImageInputDeclaration,
  visionNamespace,
  type VisionSettings,
} from './settings.js'
import { TOOL_NAME, TOOLSET, TOOL_EMOJI, defineVisionTool } from './tool.js'

export const name = 'dsh-vision-tool'

/** 依赖的服务：全部就绪后 apply 才会执行（Cordis 注入）。 */
export const inject = ['tools', 'settings', 'llm', 'attachments', 'systemPrompt']

/**
 * 注入到 agent 系统提示词的引导段（工具引导区，order 100–199）。
 * 只在工具处于注册状态时渲染：未配置模型时返回空串，整段自动从提示词里消失 ——
 * 这正是「没配置模型，上下文看不见这个工具」在提示词侧的对应物。
 */
const GUIDANCE_SECTION = [
  '## ' + TOOLSET + ' toolset (' + TOOL_EMOJI + ' ' + TOOL_NAME + ')',
  '',
  'Use ' + TOOL_NAME + ' whenever the user references an image: a filepath in their message,',
  'an image URL in tool output, a browser screenshot, or a data URL. Provide the image plus',
  'a concrete question. Prefer calling it once per image; use the region parameter to zoom',
  'into small details instead of re-loading the whole image.',
].join('\n')

export function apply(ctx: Context, config: Config) {
  // 1) 设置命名空间 'vision'：注册 schema（含组合层 base），得到可 watch 的 scope。
  //    该命名空间只供宿主内部使用；Web 设置页经插件自有的 Typert Remote 读写。
  const scope = ctx.settings.register(visionNamespace(config), VisionSettingsSchema, {
    base: {
      ...(config.provider !== undefined ? { provider: config.provider } : {}),
      ...(config.model !== undefined ? { model: config.model } : {}),
    },
  })

  // 1b) 注册 Typert Remote 命名空间 'vision'（vision/describe、vision/save），
  //     作为设置页的读写通道 —— 不占用模型页的提供方目录，模型页保持干净。
  ctx.plugin(VisionRemoteService, { namespace: config.namespace ?? 'vision' })

  // 2) 按「已配置」条件注册/卸载工具 —— 未配置模型时 agent 上下文里没有这个工具。
  let disposeTool: (() => void) | undefined

  const refresh = (settings: VisionSettings) => {
    if (isVisionConfigured(settings)) {
      if (!disposeTool) {
        disposeTool = ctx.tools.register(
          defineVisionTool({ ctx, config, getSettings: () => scope.get() }),
        )
        ctx.logger.info(
          '[dsh-vision-tool] vision_analyze registered (' +
            settings.provider.trim() + ' / ' + settings.model.trim() + ')',
        )
      }
    } else if (disposeTool) {
      disposeTool()
      disposeTool = undefined
      ctx.logger.info('[dsh-vision-tool] vision_analyze unregistered: no vision model selected')
    }
  }

  refresh(scope.get())

  // 3) 设置变化 → 刷新工具注册状态 + 同步图片能力声明（llm-pi-ai modelOverrides）。
  const unwatch = scope.watch((next, prev) => {
    refresh(next)
    void syncImageInputDeclaration(ctx, next, prev)
  })
  void syncImageInputDeclaration(ctx, scope.get(), undefined)

  // 4) agent 侧的「提示词」：工具引导段（未配置时自动隐藏）。
  ctx.systemPrompt.section({
    name: 'dsh-vision-tool:guidance',
    order: 150,
    text: () => (disposeTool ? GUIDANCE_SECTION : ''),
  })

  // 5) 卸载时清理条件注册（Cordis 会自动清理其余注册，这里只做显式收尾）。
  ctx.effect(() => () => {
    unwatch()
    disposeTool?.()
    disposeTool = undefined
  })
}

export { Config, TOOL_NAME, TOOLSET, TOOL_EMOJI }
export { DEFAULT_PROMPT_TEMPLATE } from './config.js'
export { isVisionConfigured, VisionSettingsSchema, type VisionSettings } from './settings.js'
export { VisionRemoteService, type VisionDescribeResult, type VisionSaveRequest } from './remote.js'
