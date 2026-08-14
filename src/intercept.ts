import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Config } from './config.js'
import type { VisionSettings } from './settings.js'
import { registerAttachmentRef } from './attachments.js'

/**
 * pre-step 图片处理（tool call 架构，图片=工作区文件）：
 *
 * 用户消息里的图片对无视觉主模型不可见（Console Go 等路由的 API 拒绝
 * image_url 块）。本拦截器把图片 block 从用户消息里**拆分**出来：
 * - 用户自己的文本保持原样（独立成条，不拼接任何占位内容）；
 * - 图片字节写入当前工作区的 `attachments/` 目录（像 zip 下载一样作为
 *   一个普通文件落在工作区，agent 的文件工具也能感知），然后替换成一条
 *   **独立的指引消息**：给出工作区相对路径 + attachment:// 引用，并指引
 *   agent 调用 vision_analyze 查看。
 *
 * 这样用户消息纯净，图片以「文件」形式存在，模型知道有图可看。
 * 完整附件引用同时登记进插件注册表，供工具按 id 读回字节。
 */

export interface ImageInterceptDeps {
  ctx: Context
  config: Config
  getSettings: () => VisionSettings
}

/** 工作区附件子目录（图片像 zip 一样落在这里）。 */
const ATTACH_DIR = 'attachments'

/** 写出的文件名：hash 前 8 位 + 原名，避免同名图片互相覆盖。 */
function attachFileName(ref: ImageAttachmentRef): string {
  const hash = ref.attachmentId.includes(':')
    ? ref.attachmentId.slice(ref.attachmentId.lastIndexOf(':') + 1).slice(0, 8)
    : ref.attachmentId.slice(0, 8)
  const name = ref.name === undefined || ref.name.trim() === '' ? 'image' : ref.name
  return `${hash}_${name}`
}

/** 图片指引消息（独立成条，绝不拼接进用户文本）。 */
export function imageGuidanceMessage(
  ref: ImageAttachmentRef,
  index: number,
  total: number,
  workspaceRelPath: string | undefined,
): UserMessage {
  const label = total > 1 ? `图片 ${index}/${total}` : '一张图片'
  const filePart = workspaceRelPath === undefined
    ? `attachment://${ref.attachmentId}`
    : `attachments/${workspaceRelPath}`
  const question = '如需查看图片内容，请调用 vision_analyze 工具，image_url 参数传 "' + filePart + '"'
  return {
    role: 'user',
    id: `vision-tool:${ref.attachmentId}:${index}` as UserMessage['id'],
    source: { kind: 'plugin', plugin: 'dsh-vision-tool' },
    content: [
      {
        type: 'text',
        text: `[用户上传了${label}：${filePart}。${question}]`,
      },
    ],
  }
}

/**
 * 把图片字节写入工作区 attachments/ 目录；失败返回 undefined（指引消息退回
 * attachment:// 引用）。
 */
async function persistToWorkspace(
  deps: ImageInterceptDeps,
  agent: { session?: { header?: { cwd?: string } } } | undefined,
  ref: ImageAttachmentRef,
): Promise<string | undefined> {
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined
  const attachments = deps.ctx.get('attachments')
  if (attachments === undefined) return undefined
  try {
    const stored = await attachments.readImage(ref)
    const dir = join(cwd, ATTACH_DIR)
    await mkdir(dir, { recursive: true })
    const fileName = attachFileName(ref)
    await writeFile(join(dir, fileName), Buffer.from(stored.data))
    return join(ATTACH_DIR, fileName)
  } catch (error) {
    deps.ctx.logger.warn('[dsh-vision-tool] failed to persist image to workspace: %s', (error as Error).message)
    return undefined
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
      // 拆分：用户文本保持原样；图片写入工作区并转为独立指引消息
      const textBlocks = message.content.filter((block: ContentBlock) => block.type !== 'image')
      if (textBlocks.length > 0) {
        next.push({ ...message, content: textBlocks })
      }
      for (const block of message.content) {
        if (block.type !== 'image' || block.attachment === undefined) continue
        imageIndex += 1
        registerAttachmentRef(block.attachment)
        const relPath = await persistToWorkspace(deps, context.agent, block.attachment)
        next.push(imageGuidanceMessage(block.attachment, imageIndex, images.length, relPath))
      }
    }
    decision.messages = next
    return decision
  })
}
