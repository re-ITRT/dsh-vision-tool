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
 * 提交前图片转换（用户直传图片路径）：
 * 在 connection.api.sessions.prompt 上装一层门，把 content 里的 image parts
 * 交给宿主 vision/transformImages —— 视觉辅助开启时换成文字描述再提交，
 * 主模型（无论有无原生视觉）都能"看到"图片内容；关闭时原样透传，
 * 行为与未安装插件完全一致（无视觉模型收到图片走 DSH 默认拒绝）。
 * 转换失败（视觉模型调用出错）时把错误透传给输入框错误条。
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
    const request = payload as { content?: { type: string; text?: string; mediaType?: string; data?: string; name?: string }[] } | undefined
    const content = request?.content ?? []
    const images = content.filter((part): part is { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string } =>
      part.type === 'image' && typeof part.mediaType === 'string' && typeof part.data === 'string')
    if (images.length === 0) return original(payload, signal)
    const result = await remote.vision.transformImages(
      { images: images.map(({ mediaType, data, name }) => ({ mediaType, data, name })) },
      signal,
    )
    if (!result.ok) return result
    if (!result.value.enabled || result.value.descriptions.length === 0) {
      return original(payload, signal)
    }
    let imageIndex = 0
    const newContent = content.map((part) => {
      if (part.type !== 'image') return part
      const description = result.value.descriptions[imageIndex] ?? ''
      imageIndex += 1
      return { type: 'text', text: `[图片 ${imageIndex} —— 视觉辅助模型描述]\n${description}` }
    })
    return original({ ...request, content: newContent }, signal)
  }
}
