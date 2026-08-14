/**
 * pre-step 图片拦截：用户消息里直接带的图片，在主模型无原生视觉时，
 * 由所选视觉辅助模型逐张转成文字描述再进入上下文 —— 主模型因此"看得见"图。
 *
 * 触发条件（全部满足才转换）：
 * - 视觉辅助总开关开启且已配置（isVisionConfigured）；
 * - 当前 agent 主模型未声明 image 输入模态（有原生视觉则不动，走原生路径）；
 * - 消息 content 里存在 {type:'image'} 块。
 *
 * 转换失败（辅助模型调用出错）时保留原消息，行为回退到 DSH 默认
 * （无视觉模型收到图片 → 适配器报 "does not support image input"），
 * 并记录 warn 日志，绝不吞掉用户输入。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { DEFAULT_PROMPT_TEMPLATE, type Config } from './config.js'
import { isVisionConfigured, type VisionSettings } from './settings.js'
import { callerHasNativeVision } from './tool.js'

export interface ImageInterceptDeps {
  ctx: Context
  config: Config
  /** 每次执行时读取最新设置（开关/模型变更即时生效）。 */
  getSettings: () => VisionSettings
}

/** 拦截场景的默认提问：描述整张图（没有用户 question 可替换）。 */
const INTERCEPT_QUESTION = 'Describe everything visible in this image, in detail.'

/**
 * 挂载 agent/pre-step 拦截器。返回 disposer（由调用方在条件注销时调用）。
 */
export function applyImageIntercept(deps: ImageInterceptDeps): () => void {
  return deps.ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (!isVisionConfigured(deps.getSettings())) return decision
    // 主模型自带视觉 → 图片直接进上下文，无需转换
    if (await callerHasNativeVision(deps.ctx, agent, signal)) return decision
    const transformed = await describeImages(deps, messages, signal)
    if (transformed === undefined) return decision
    return { kind: 'enter', messages: transformed }
  })
}

/**
 * 把 messages 中所有含图片的用户消息转成「原文本 + 图片描述」。
 * 无图片时返回 undefined（不修改）；任一张图转换失败时整批放弃（回退默认）。
 */
async function describeImages(
  deps: ImageInterceptDeps,
  messages: readonly UserMessage[],
  signal: AbortSignal,
): Promise<UserMessage[] | undefined> {
  let changed = false
  const result: UserMessage[] = []
  for (const message of messages) {
    if (message.role !== 'user') {
      result.push(message)
      continue
    }
    const images = message.content.filter(
      (block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image',
    )
    if (images.length === 0) {
      result.push(message)
      continue
    }
    const descriptions = await describeEachImage(deps, images, signal)
    if (descriptions === undefined) return undefined
    changed = true
    const newContent: ContentBlock[] = []
    let imageIndex = 0
    for (const block of message.content) {
      if (block.type === 'image') {
        const description = descriptions[imageIndex] ?? ''
        imageIndex += 1
        newContent.push({
          type: 'text',
          text: `[图片 ${imageIndex} —— 视觉辅助模型描述]\n${description}`,
        })
      } else {
        newContent.push(block)
      }
    }
    result.push(createUserMessage({ source: message.source, content: newContent }))
  }
  return changed ? result : undefined
}

/**
 * 逐张调用所选视觉辅助模型，返回每张图的描述文本。
 * 任一张失败（网络/模型错误/空输出）返回 undefined。
 */
export async function describeEachImage(
  deps: ImageInterceptDeps,
  images: Extract<ContentBlock, { type: 'image' }>[],
  signal: AbortSignal,
): Promise<string[] | undefined> {
  return describeAttachments(deps, images.map(image => image.attachment), signal)
}

/**
 * 逐张调用所选视觉辅助模型描述附件引用（供拦截器与 transformImages 共用）。
 * 任一张失败（网络/模型错误/空输出）返回 undefined。
 */
export async function describeAttachments(
  deps: ImageInterceptDeps,
  attachments: readonly ImageAttachmentRef[],
  signal: AbortSignal,
): Promise<string[] | undefined> {
  const settings = deps.getSettings()
  const template = deps.config.promptTemplate ?? DEFAULT_PROMPT_TEMPLATE
  const prompt = template.includes('{question}')
    ? template.split('{question}').join(INTERCEPT_QUESTION)
    : template + '\n\n' + INTERCEPT_QUESTION
  const descriptions: string[] = []
  for (const attachment of attachments) {
    const message = createUserMessage({
      source: { kind: 'plugin', plugin: 'dsh-vision-tool' },
      content: [
        { type: 'text', text: prompt },
        { type: 'image', attachment },
      ],
    })
    let text = ''
    try {
      for await (const chunk of deps.ctx.llm.stream({
        provider: settings.provider.trim(),
        model: settings.model.trim(),
        system: deps.config.systemPrompt,
        messages: [message],
        signal,
      })) {
        if (chunk.type === 'text-delta') text += chunk.text
      }
    } catch (error) {
      deps.ctx.logger.warn(
        '[dsh-vision-tool] image intercept: vision model call failed: %s',
        (error as Error).message,
      )
      return undefined
    }
    const trimmed = text.trim()
    if (!trimmed) {
      deps.ctx.logger.warn('[dsh-vision-tool] image intercept: vision model returned no text')
      return undefined
    }
    descriptions.push(trimmed)
  }
  return descriptions
}
