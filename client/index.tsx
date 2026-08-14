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

  // 2) 命名空间服务就绪后，由子插件注册设置页
  ctx.plugin({
    name: 'dsh-vision-tool.section',
    inject: ['slots', 'remote', 'remote.vision'],
    apply(inner) {
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
