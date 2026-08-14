import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Config } from './config.js'
import { loadImage } from './image.js'
import { DEFAULT_PROMPT_TEMPLATE } from './config.js'
import { isVisionConfigured, type VisionSettings } from './settings.js'

/** 注册信息（与需求方给定的规格一致）。 */
export const TOOL_NAME = 'vision_analyze'
/**
 * 工具分组。当前 DSH rc.6 的 ToolDefinition 没有 toolset 字段，这里仅作为
 * 插件内的分组元数据/命名约定；system-prompt 的引导段与设置页都按 vision 分组呈现。
 */
export const TOOLSET = 'vision'
/**
 * 终端/桌面 UI 的显示图标，纯装饰：不进系统提示（模型只看到 name + description +
 * parameters），也不影响 LLM 调用。对应 Python 侧 registry.register(..., emoji=...)；
 * 在 DSH 里通过工具调用卡片（presentCall 的 title）呈现。皮肤覆盖系统暂不实现。
 */
export const TOOL_EMOJI = '👁️'

/** 面向模型/agent 的工具描述（需求方给定的原文）。 */
const TOOL_DESCRIPTION =
  'Load an image into the conversation so you can see it. Accepts a URL, local file path, or data URL. ' +
  "When your active model has native vision, the image is attached to your context directly and you read the " +
  'pixels yourself on the next turn — call this any time the user references an image (filepath in their message, ' +
  'URL in tool output, screenshot from the browser, etc.). For non-vision models, falls back to an auxiliary ' +
  'vision model that returns a text description.'

const IMAGE_URL_DESCRIPTION =
  'Image URL (http/https), local file path, or data: URL to load.'
const QUESTION_DESCRIPTION =
  'Your specific question or request about the image. Optional context the model uses on the next turn after seeing the image.'
const REGION_DESCRIPTION =
  'Optional [x1, y1, x2, y2] crop region in pixel coordinates of the ORIGINAL image, applied before any downscaling ' +
  'so the region keeps full resolution. Intended flow: load the full image first, then call again with a region to ' +
  'zoom into a detail (small text, UI element, fine print). Coordinates are clamped to the image bounds.'

export interface VisionToolDeps {
  ctx: Context
  config: Config
  /** 每次执行时读取最新设置（设置页保存后即时生效，无需重启）。 */
  getSettings: () => VisionSettings
}

export function defineVisionTool(deps: VisionToolDeps) {
  return defineTool({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: {
      image_url: {
        type: 'string',
        required: true,
        description: IMAGE_URL_DESCRIPTION,
      },
      question: {
        type: 'string',
        required: true,
        description: QUESTION_DESCRIPTION,
      },
      region: {
        type: 'array',
        items: { type: 'integer' },
        description: REGION_DESCRIPTION,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string', required: true },
          question: { type: 'string', required: true },
          mode: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.description }],
    },
    async execute(args, exec) {
      const settings = deps.getSettings()
      if (!isVisionConfigured(settings)) {
        throw new Error(
          'vision_analyze: no vision model selected — open Settings → Vision and pick a model first',
        )
      }

      const loaded = await loadImage(
        args.image_url,
        args.region,
        exec.signal,
        {
          maxDimension: deps.config.maxDimension ?? 1568,
          jpegQuality: deps.config.jpegQuality ?? 90,
        },
      )
      const attachment = await deps.ctx.attachments.saveImage({
        data: loaded.data,
        mediaType: loaded.mediaType,
        name: loaded.name,
      })

      // 当前 agent 的模型自带视觉能力 → 直接把图片挂进 agent 上下文，下一轮模型自己看像素
      if (await callerHasNativeVision(deps.ctx, exec.agent, exec.signal)) {
        exec.deferContext(createUserMessage({
          source: { kind: 'plugin', plugin: 'dsh-vision-tool' },
          content: [
            { type: 'text', text: 'The image below was loaded for the question: ' + args.question },
            { type: 'image', attachment },
          ],
        }))
        return {
          description:
            'The image (' + loaded.width + 'x' + loaded.height + ') is now attached to your context. ' +
            'On your next turn you can see it directly — read the pixels yourself and answer: ' + args.question,
          question: args.question,
          mode: 'attached',
          width: loaded.width,
          height: loaded.height,
        }
      }

      // 无原生视觉 → 调用辅助视觉模型，把完整描述作为文本结果返回给 agent
      const prompt = buildPrompt(deps.config.promptTemplate ?? DEFAULT_PROMPT_TEMPLATE, args.question)
      const message = createUserMessage({
        source: { kind: 'plugin', plugin: 'dsh-vision-tool' },
        content: [
          { type: 'text', text: prompt },
          { type: 'image', attachment },
        ],
      })
      let description = ''
      try {
        for await (const chunk of deps.ctx.llm.stream({
          provider: settings.provider.trim(),
          model: settings.model.trim(),
          system: deps.config.systemPrompt,
          messages: [message],
          signal: exec.signal,
        })) {
          if (chunk.type === 'text-delta') description += chunk.text
        }
      } catch (error) {
        const detail = (error as Error).message
        throw new Error(
          'vision_analyze: vision model call failed (' + detail + '). ' +
            'Check 设置 → Vision: provider=' + settings.provider.trim() +
            ' model=' + settings.model.trim() +
            '（该模型需接受图片输入；OpenAI 兼容路由保存选择后会自动声明 input: [text, image]）',
        )
      }
      const text = description.trim()
      if (!text) throw new Error('vision_analyze: vision model returned no text')
      return {
        description: text,
        question: args.question,
        mode: 'described',
        width: loaded.width,
        height: loaded.height,
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      kind: 'fetch',
      title: TOOL_EMOJI + ' ' + TOOL_NAME,
      rawInput: { question: args.question, image_url: args.image_url },
    }),
  })
}

/**
 * 当前 agent 模型是否声明了 image 输入模态。拦截器与工具执行共用：
 * 有原生视觉 → 图片直接进上下文；没有 → 走辅助模型。
 */
export async function callerHasNativeVision(
  ctx: Context,
  agent: { options?: { provider?: string; model?: string } } | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  const options = agent?.options
  if (!options?.provider || !options?.model) return false
  try {
    const info = await ctx.llm.resolveModelInfo(options.provider, options.model, signal)
    return info.inputModalities?.includes('image') ?? false
  } catch {
    return false
  }
}

/** 替换 {question} 占位符；模板没有占位符时把问题追加到末尾。 */
function buildPrompt(template: string, question: string): string {
  if (template.includes('{question}')) {
    return template.split('{question}').join(question)
  }
  return template + '\n\n' + question
}
