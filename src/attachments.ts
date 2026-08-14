import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/**
 * 会话图片附件注册表（插件内共享）。
 *
 * 用户消息里的图片在 DSH 附件服务里是 content-addressed 存储，读取需要完整
 * 的 ImageAttachmentRef（attachmentId + mediaType + bytes + width + height，
 * 本地存储会校验这些字段与内容一致）。pre-step 拦截器拿到完整 ref 后在这里
 * 登记，vision_analyze 工具收到 attachment://<id> 时按 id 查回完整 ref 再读取。
 *
 * 模块级单例：同一进程内跨 remote / 拦截器 / 工具共享。进程重启后历史附件
 * 引用会查不到（工具会给出「附件已失效，请重新上传」的明确报错）。
 */
const registry = new Map<string, ImageAttachmentRef>()

/** 登记一条附件引用；同一 id 重复登记时保留最新的完整信息。 */
export function registerAttachmentRef(ref: ImageAttachmentRef): void {
  registry.set(ref.attachmentId, ref)
}

/** 按 attachment:// 前缀里的 id 查回完整附件引用；未登记返回 undefined。 */
export function lookupAttachmentRef(attachmentId: string): ImageAttachmentRef | undefined {
  return registry.get(attachmentId)
}

/** 清理登记（插件卸载/开关关闭时调用）。 */
export function clearAttachmentRegistry(): void {
  registry.clear()
}
