/**
 * 视觉设置页的 store：对 ctx.remote.vision 的 describe/save 做薄封装，
 * 快照交给 useSyncExternalStore（与官方「模型」页 store 同一种写法）。
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { VisionDescribeResult } from './remote.js'

export interface VisionPageState {
  status: 'loading' | 'ready' | 'error'
  error?: string
  data?: VisionDescribeResult
  saving: boolean
  saveError?: string
}

export class VisionPageStore {
  store = createSnapshotStore<VisionPageState>({ status: 'loading', saving: false })
  private generation = 0

  constructor(private readonly remote: TypertClientRemote) {}

  async load(): Promise<void> {
    const generation = ++this.generation
    try {
      const result = await this.remote.vision.describe()
      if (generation !== this.generation) return
      if (!result.ok) {
        this.store.set({ status: 'error', error: result.error.message, saving: false })
        return
      }
      this.store.set({ status: 'ready', data: result.value, saving: false })
    } catch (error) {
      if (generation !== this.generation) return
      this.store.set({ status: 'error', error: (error as Error).message, saving: false })
    }
  }

  /** 选择 provider+model，保存后重新加载。 */
  async select(provider: string, model: string): Promise<boolean> {
    if (!this.store.getSnapshot().saving) {
      this.store.update((s) => {
        s.saving = true
        s.saveError = undefined
      })
    }
    try {
      const result = await this.remote.vision.save({ provider, model })
      if (!result.ok) {
        this.store.update((s) => {
          s.saving = false
          s.saveError = result.error.message
        })
        return false
      }
      this.store.set({ status: 'ready', data: result.value, saving: false })
      return true
    } catch (error) {
      this.store.update((s) => {
        s.saving = false
        s.saveError = (error as Error).message
      })
      return false
    }
  }
}
