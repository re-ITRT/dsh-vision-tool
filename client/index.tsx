/**
 * dsh-vision-tool 的浏览器半：向设置面板注册 'vision' 设置页（settings.section），
 * 并把插件的 Typert Remote 命名空间 vision（describe/save）挂到 ctx.remote。
 * 页面数据经 remote 直连宿主（不走 settings 白名单），模型下拉框的数据与
 * 对话框右下角模型选择器同源（模型目录）。
 *
 * 结构说明（避免鸡生蛋死锁）：$mount 创建的 remote.vision 命名空间本身是一个
 * cordis 服务，必须在消费它的插件里显式 inject。因此拆成两层 ——
 *   1. 本插件（inject: ['remote']）只负责 $mount；
 *   2. 挂载完成后启动子插件（inject: ['slots', 'remote', 'remote.vision']）注册设置页。
 * 与官方 dsh-api-remotes（挂载）→ dsh-client-ui-commands（注入 remote.commands）同构。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
// 拉入 settings.section slot 契约与 Context.remote 的声明合并
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes'
import { VISION_TYPERT_REMOTE } from './remote.js'
import { VisionPageStore } from './store.js'
import { VisionSection, type VisionSectionInjected } from './VisionSection.js'

/** 客户端 Cordis 注入的服务。 */
/**
 * 其他格式上传通道（drop 附件式）：
 * DSH 原生只收图片 drop（addImages）。本钩子捕获 document 级 drop 里的
 * **非图片文件**（zip/pdf/txt/py...），交给宿主 vision/persistFile 写入
 * 工作区 attachments/（像 zip 下载一样成为普通文件），然后把引用文本
 * 注入输入框末尾 —— 视觉辅助开启时给完整指引，关闭时仅给路径引用。
 * 图片文件留给 DSH 原生流程（addImages / pre-step 拆分）。
 */
function installFileDrop(inner: {
  remote: TypertClientRemote
  logger: { warn(...args: unknown[]): void }
}): () => void {
  const onDrop = (event: DragEvent): void => {
    const files = Array.from(event.dataTransfer?.files ?? [])
    const nonImages = files.filter((file) => !file.type.startsWith('image/'))
    if (nonImages.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    void (async () => {
      for (const file of nonImages) {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
          reader.onerror = () => reject(reader.error)
          reader.readAsDataURL(file)
        })
        const result = await inner.remote.vision.persistFile(
          { sessionId: '', name: file.name, mediaType: file.type || 'application/octet-stream', data },
          undefined,
        )
        if (!result.ok) {
          inner.logger.warn('[dsh-vision-tool] persistFile failed: %s', String(result.error))
          return
        }
        const { relPath, size, enabled } = result.value
        const sizeText = size >= 1024 * 1024
          ? (size / 1024 / 1024).toFixed(1) + ' MiB'
          : size >= 1024 ? Math.round(size / 1024) + ' KiB' : size + ' B'
        const text = enabled
          ? `[用户上传了文件：${relPath}（${sizeText}）。可用文件工具查看/解压处理]`
          : `attachments/${relPath}`
        appendToComposer('\n' + text)
      }
    })().catch((error: unknown) => {
      inner.logger.warn('[dsh-vision-tool] file drop handling failed: %s', (error as Error).message)
    })
  }
  document.addEventListener('drop', onDrop, true)
  return () => document.removeEventListener('drop', onDrop, true)
}

/** 向当前输入框末尾追加文本（原生 setter 触发 React 受控更新）。 */
function appendToComposer(text: string): void {
  const textarea = document.querySelector<HTMLTextAreaElement>('textarea[placeholder]')
  if (!textarea) return
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (!setter) return
  setter.call(textarea, textarea.value + text)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  textarea.focus()
}

export const inject = ['remote']

export async function apply(ctx: ClientContext) {
  // 1) 挂载 vision Remote 命名空间（在根 ctx 上注册 'remote.vision' 服务）
  await ctx.remote.$mount(VISION_TYPERT_REMOTE)

  // 2) 命名空间服务就绪后，由子插件注册设置页 + 提交前图片转换
  ctx.plugin({
    name: 'dsh-vision-tool.section',
    inject: ['slots', 'remote', 'remote.vision', 'connection'],
    apply(inner) {
      installPromptImageGate(inner)
      const disposeFileDrop = installFileDrop(inner)
      inner.effect(() => () => disposeFileDrop())
      const store = new VisionPageStore(inner.remote)
      const injected = (): VisionSectionInjected => ({ store })
      inner.slots.inject('settings.section', () => inner.slots.register({
        name: 'settings.section',
        id: 'vision',
        order: 20,
        label: () => '👁️ 视觉 / Vision',
        inject: injected,
      }, VisionSection))
    },
  })
}

/**
 * 提交前放行检查（用户直传图片路径，tool call 架构）：
 * 在 connection.api.sessions.prompt 上装一层门 —— 当消息里带图片时，先问
 * 宿主 vision/ensureImageAdmission 是否放行（视觉辅助开启时会给当前主模型
 * 写 pi-ai 图片声明，让 apiproxy 门禁放行）。**content 原样提交**：图片以
 * image block 进入会话历史/UI，pre-step 拦截器再把它替换成占位文本，
 * 内容获取由 agent 调用 vision_analyze 工具完成 —— 与 Hermes 一致，
 * 模型通过 tool call 决定是否、如何查看图片。
 * 未放行时也原样提交 —— 行为与未安装插件一致（DSH 默认拒绝无视觉模型的
 * 图片消息）。转换/放行检查失败不吞错，透传给输入框错误条。
 */
function installPromptImageGate(inner: {
  get: (name: string) => unknown
  remote: TypertClientRemote
  logger: { warn(...args: unknown[]): void }
}): void {
  const connection = inner.get('connection') as { api: { sessions: { prompt: (payload: unknown, signal?: AbortSignal) => Promise<unknown> } } } | undefined
  const remote = inner.remote
  if (connection === undefined || connection.api?.sessions?.prompt === undefined) return
  const sessions = connection.api.sessions
  const original = sessions.prompt.bind(sessions)
  sessions.prompt = async (payload: unknown, signal?: AbortSignal) => {
    const request = payload as { sessionId?: string; content?: { type: string }[] } | undefined
    const content = request?.content
    const hasImage = Array.isArray(content) && content.some((part) => part.type === 'image')
    if (!hasImage) return original(payload, signal)
    const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : undefined
    if (sessionId !== undefined) {
      const result = await remote.vision.ensureImageAdmission({ sessionId }, signal)
      if (!result.ok) {
        inner.logger.warn('[dsh-vision-tool] ensureImageAdmission failed: %s', String(result.error))
      }
    }
    // 无论放行与否都原样提交：放行 → 图片进消息，pre-step 替换成占位；
    // 未放行 → DSH 默认拒绝（与原版一致）。
    return original(payload, signal)
  }
}
