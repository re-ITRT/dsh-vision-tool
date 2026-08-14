import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Config } from './config.js'
import type { VisionSettings } from './settings.js'
import { registerAttachmentRef } from './attachments.js'

/**
 * pre-step 图片处理（tool call 架构）：
 *
 * 用户消息里的图片对无视觉主模型不可见（Console Go 等路由的 API 拒绝
 * image_url 块）。本拦截器把图片 block 从用户消息里**拆分**出来：
 * - 用户自己的文本保持原样（独立成条，不拼接任何占位内容 —— 用户的话
 *   就是用户的话）；
 * - 图片替换成一条**独立的指引消息**（同一步骤里紧随其后）：说明有一张
 *   图片附件（attachment://<id>），并指引 agent 调用 vision_analyze 查看。
 *
 * 这样用户消息纯净，模型也知道有图可看（工具提示不再"组合"进用户言论，
 * 与 Hermes 的附件独立呈现一致）。完整附件引用同时登记进插件注册表，
 * 供工具按 id 读回字节。
 */

export interface ImageInterceptDeps {
  ctx: Context
  config: Config
  getSettings: () => VisionSettings
}

/** 图片指引消息（独立成条，绝不拼接进用户文本）。 */
export function imageGuidanceMessage(ref: ImageAttachmentRef, index: number, total: number): UserMessage {
  const name = ref.name === undefined ? '未命名图片' : ref.name
  const size = ref.width > 0 && ref.height > 0 ? `${ref.width}x${ref.height} ` : ''
  const label = total > 1 ? `图片 ${index}/${total}` : '一张图片'
  return {
    role: 'user',
    id: `vision-tool:${ref.attachmentId}:${index}` as UserMessage['id'],
    source: { kind: 'plugin', plugin: 'dsh-vision-tool' },
    content: [
      {
        type: 'text',
        text:
          `[用户上传了${label}：${name}（${size}${ref.mediaType}，attachment://${ref.attachmentId}）。` +
          `如需查看图片内容，请调用 vision_analyze 工具，image_url 参数传 "attachment://${ref.attachmentId}"]`,
      },
    ],
  }
}

/**
 * 挂载 pre-step 图片拦截器。返回 disposer。
 * 触发条件（由调用方在开关/配置变化时重新评估）：
 * - 视觉辅助已配置（开关开 + 模型已选）
 * - 消息里含图片 block
 * 无图时零开销原样返回。
 */
export function applyImageIntercept(deps: ImageInterceptDeps): () => void {
  return deps.ctx.on('agent/pre-step', async (context) => {
    const decision: PreStepDecision = { kind: 'enter', messages: context.messages }

    const images: Extract<ContentBlock, { type: 'image' }>[] = []
    for (const message of context.messages) {
      if (message.role !== 'user') continue
      const content = message.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block.type === 'image') images.push(block)
      }
    }
    if (images.length === 0) return decision

    const next: UserMessage[] = []
    let imageIndex = 0
    for (const message of context.messages) {
      if (message.role !== 'user' || !Array.isArray(message.content)) {
        next.push(message as UserMessage)
        continue
      }
      if (!message.content.some((block: ContentBlock) => block.type === 'image')) {
        next.push(message as UserMessage)
        continue
      }
      // 拆分：用户文本保持原样；图片登记后转为独立指引消息
      const textBlocks = message.content.filter((block: ContentBlock) => block.type !== 'image')
      if (textBlocks.length > 0) {
        next.push({ ...message, content: textBlocks })
      }
      for (const block of message.content) {
        if (block.type !== 'image' || block.attachment === undefined) continue
        imageIndex += 1
        registerAttachmentRef(block.attachment)
        next.push(imageGuidanceMessage(block.attachment, imageIndex, images.length))
      }
    }
    decision.messages = next
    return decision
  })
}
