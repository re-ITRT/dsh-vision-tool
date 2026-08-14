/**
 * 视觉设置页 —— 与官方「模型」页同源的数据与交互：
 * - 模型下拉框：数据来自模型目录（vision/describe），交互用与对话框右下角
 *   模型选择器相同的 Menu 下拉组件；
 * - 选择即保存（vision/save），状态点显示工具是否启用；
 * - 目录外的模型可以手动输入 provider + model ID。
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Button, Input, Menu, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { VisionPageState, VisionPageStore } from './store.js'

export interface VisionSectionInjected {
  store: VisionPageStore
}

type Props = Partial<VisionSectionInjected> & { close?: () => void }

/** 下拉框条目的 id 编码：provider \u0000 model。 */
function entryId(provider: string, model: string): string {
  return provider + '\u0000' + model
}

function decodeEntryId(id: string): { provider: string; model: string } {
  const index = id.indexOf('\u0000')
  return index < 0
    ? { provider: '', model: id }
    : { provider: id.slice(0, index), model: id.slice(index + 1) }
}

export function VisionSection(props: Props) {
  const store = props.store

  const snap = useSyncExternalStore(
    (listener: () => void) => (store ? store.store.subscribe(listener) : () => {}),
    () => (store ? store.store.getSnapshot() : EMPTY_SNAPSHOT),
  )

  useEffect(() => {
    if (store && snap.status === 'loading') void store.load()
  }, [store])

  const [open, setOpen] = useState(false)
  const [manual, setManual] = useState(false)
  const [manualProvider, setManualProvider] = useState('')
  const [manualModel, setManualModel] = useState('')

  const data = snap.data
  const enabled = data?.enabled === true
  const configured = data?.configured === true
  const currentProvider = data?.provider ?? ''
  const currentModel = data?.model ?? ''
  const groups = data?.groups ?? []
  const totalModels = groups.reduce((sum, group) => sum + group.models.length, 0)

  const knownId = useMemo(() => {
    if (!currentProvider || !currentModel) return undefined
    for (const group of groups) {
      if (group.id !== currentProvider) continue
      if (group.models.some((model) => model.id === currentModel)) {
        return entryId(currentProvider, currentModel)
      }
    }
    return undefined
  }, [groups, currentProvider, currentModel])

  const items = useMemo<MenuEntry[]>(() => {
    const entries: MenuEntry[] = []
    if (knownId === undefined && currentProvider && currentModel) {
      entries.push(
        { type: 'label', id: 'current', text: '当前选择' },
        { id: entryId(currentProvider, currentModel), label: currentModel + '（' + currentProvider + '）' },
        { type: 'separator', id: 'sep-current' },
      )
    }
    groups.forEach((group) => {
      if (group.models.length === 0) return
      entries.push({ type: 'label', id: 'g-' + group.id, text: group.name })
      for (const model of group.models) {
        entries.push({
          id: entryId(group.id, model.id),
          label: (
            <span>
              {model.vision ? '👁️ ' : ''}
              {model.name}
              <span style={{ opacity: 0.6, marginLeft: 6, fontSize: 12 }}>{model.id}</span>
            </span>
          ),
        })
      }
      entries.push({ type: 'separator', id: 'sep-' + group.id })
    })
    entries.push(
      { type: 'label', id: 'manual-label', text: '目录外模型' },
      { id: 'vision:manual', label: '✏️ 手动输入模型 ID…' },
    )
    return entries
  }, [groups, currentProvider, currentModel, knownId])

  if (!store) {
    return <p>vision 设置服务未挂载。</p>
  }

  const onSelect = (id: string) => {
    setOpen(false)
    if (id === 'vision:manual') {
      setManual(true)
      return
    }
    const { provider, model } = decodeEntryId(id)
    void store.select(provider, model)
  }

  const applyManual = () => {
    if (!manualProvider.trim() || !manualModel.trim()) return
    void store.select(manualProvider.trim(), manualModel.trim()).then((ok) => {
      if (ok) {
        setManual(false)
        setManualProvider('')
        setManualModel('')
      }
    })
  }

  const toggleEnabled = () => {
    if (!store || snap.saving) return
    void store.setEnabled(!enabled).then((ok) => {
      if (ok && !enabled) setOpen(false)
    })
  }

  const currentLabel = configured
    ? currentModel + '（' + currentProvider + '）'
    : '选择视觉模型…'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 }}>
      {/* 总开关 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 12px',
          borderRadius: 8,
          border: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.25))',
        }}
      >
        <StateDot state={enabled ? 'done' : 'warning'} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>视觉辅助（Vision assist）</span>
          <span style={{ fontSize: 12, opacity: 0.75 }}>
            {enabled
              ? '已开启：消息里的图片会交给视觉模型描述后进入上下文；agent 也可用 vision_analyze 自行查看图片。'
              : '已关闭：与未安装插件时完全一致（无视觉功能的模型收到图片会提示无视觉功能）。'}
          </span>
        </div>
        <Button
          variant={enabled ? 'primary' : 'outline'}
          size="sm"
          disabled={snap.saving || snap.status !== 'ready'}
          onClick={toggleEnabled}
        >
          {snap.saving ? '保存中…' : enabled ? '开启中' : '未开启'}
        </Button>
      </div>

      {/* 状态行 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StateDot state={configured ? 'done' : 'warning'} />
        <span>
          {configured
            ? '👁️ vision_analyze 已启用：agent 可以调用该工具查看图片，消息图片也会自动转成描述。'
            : enabled
              ? '👁️ vision_analyze 待配置：请选择视觉模型，工具才会出现在 agent 上下文。'
              : '👁️ vision_analyze 未配置：开启开关并选择视觉模型后生效。'}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span>视觉模型（Vision model）</span>
        <Menu
          open={open && !snap.saving}
          portal
          onClose={() => setOpen(false)}
          onSelect={onSelect}
          selectedId={knownId}
          items={items}
          anchor={
            <Button
              variant="outline"
              size="sm"
              disabled={snap.saving || snap.status !== 'ready'}
              onClick={() => setOpen(true)}
              style={{ justifyContent: 'space-between', gap: 24 }}
            >
              <span>{snap.saving ? '保存中…' : currentLabel}</span>
              <span style={{ opacity: 0.6 }}>▾</span>
            </Button>
          }
        />
        <span style={{ fontSize: 12, opacity: 0.7 }}>
          与对话框右下角的模型选择器同源（模型目录）。带 👁️ 的模型已声明图片输入；
          选择其它 OpenAI 兼容路由的模型时，保存后会自动为其声明 input: [text, image]。
          {totalModels === 0 ? ' 当前目录为空，请用下方的手动输入。' : ''}
        </span>
      </div>

      {manual ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontSize: 13 }}>手动输入（目录外模型）</span>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>提供方路由（Provider）</span>
            <Input
              value={manualProvider}
              placeholder="如 opencode-go"
              onChange={(event) => setManualProvider(event.target.value)}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>模型 ID（Model）</span>
            <Input
              value={manualModel}
              placeholder="如 qwen-vl-max"
              onChange={(event) => setManualModel(event.target.value)}
            />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="primary" size="sm" disabled={snap.saving} onClick={applyManual}>
              应用
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setManual(false)}>
              取消
            </Button>
          </div>
        </div>
      ) : null}

      {snap.status === 'error' ? (
        <p style={{ color: 'var(--dsw-alias-danger, #c0392b)', fontSize: 13 }}>
          加载失败：{snap.error}
        </p>
      ) : null}
      {snap.saveError ? (
        <p style={{ color: 'var(--dsw-alias-danger, #c0392b)', fontSize: 13 }}>
          保存失败：{snap.saveError}
        </p>
      ) : null}
    </div>
  )
}

const EMPTY_SNAPSHOT: VisionPageState = { status: 'loading', saving: false }
