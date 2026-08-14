import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Config } from './config.js'
import type { VisionSettings } from './settings.js'
import { registerAttachmentRef } from './attachments.js'

/**
 * pre-step 图片拦截器（tool call 架构）：
 *
 * 用户消息里的图片（image block）对模型不可见 —— 本拦截器在每一步发送给
 * 模型的 messages 里把图片 block 替换成一段**短占位文本**：说明有一张图片
 * 附件（attachment://<id>），并指引 agent 通过 vision_analyze 工具查看。
 * 图片本身始终留在会话历史/UI 里；内容获取完全由 agent 的 tool call 决定
 * —— 与 Hermes 的 vision_analyze 一致。
 *
 * 无条件拦截（视觉辅助开启时）：即使主模型声明了 image 输入模态也不把图
 * 直接放进请求 —— 主模型可能只是被放行声明（modelOverrides）「假装」支持，
 * 由 agent 决定是否调用工具最稳妥；有原生视觉的模型经工具 attach 后同样
 * 能直接看像素。
 *
 * 同时把完整附件引用登记进插件注册表，供工具按 id 读回字节。
 */

export interface ImageInterceptDeps {
  ctx: Context
  config: Config
  getSettings: () => VisionSettings
}

/** 图片占位文本（发给主模型的最小形态，不含任何图片描述内容）。 */
export function imagePlaceholder(ref: ImageAttachmentRef, index: number, total: number): string {
  const name = ref.name === undefined ? '未命名图片' : ref.name
  const size = ref.width > 0 && ref.height > 0 ? `${ref.width}x${ref.height} ` : ''
  const label = total > 1 ? `图片 ${index}/${total}` : '一张图片'
  return (
    `[用户上传了${label}：${name}（${size}${ref.mediaType}，attachment://${ref.attachmentId}）。` +
    `本模型无法直接看到图片内容 —— 如需查看，请调用 vision_analyze 工具，` +
    `image_url 参数传 "attachment://${ref.attachmentId}"]`
  )
}

/**
 * 挂载 pre-step 图片拦截器。返回 disposer。
 * 触发条件（由调用方在开关/配置变化时重新评估）：
 * - 视觉辅助已配置（开关开 + 模型已选）
 * - 消息里含图片 block
 * - 当前 agent 主模型无原生视觉（有视觉时图片直接进上下文，不拦截）
 */
export function applyImageIntercept(deps: ImageInterceptDeps): () => void {
  return deps.ctx.on('agent/pre-step', async (context) => {
    const messages = context.messages
    const decision: PreStepDecision = { kind: 'enter', messages }
    if (messages.length === 0) return decision

    const images: Extract<ContentBlock, { type: 'image' }>[] = []
    for (const message of messages) {
      if (message.role !== 'user') continue
      const content = message.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block.type === 'image') images.push(block)
      }
    }
    if (images.length === 0) return decision

    const replaced = replaceImagesWithPlaceholders(messages, images)
    if (replaced !== undefined) {
      decision.messages = replaced as UserMessage[]
    }
    return decision
  })
}

/** 把 messages 里的图片 block 替换成占位文本；同时登记附件引用。 */
function replaceImagesWithPlaceholders(
  messages: readonly { role: string; content: unknown }[],
  images: Extract<ContentBlock, { type: 'image' }>[],
): { role: string; content: unknown }[] | undefined {
  let changed = false
  let imageIndex = 0
  const next = messages.map((message) => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return message
    if (!message.content.some((block: ContentBlock) => block.type === 'image')) return message
    imageIndex += 1
    const content = message.content.map((block: ContentBlock) => {
      if (block.type !== 'image') return block
      const ref = block.attachment
      if (ref === undefined) return block
      registerAttachmentRef(ref)
      changed = true
      return { type: 'text', text: imagePlaceholder(ref, imageIndex, images.length) }
    })
    return { ...message, content }
  })
  return changed ? next : undefined
}
