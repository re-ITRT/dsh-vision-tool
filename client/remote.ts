/**
 * dsh-vision-tool 的 Typert Remote 客户端贡献（手写，等价于官方生成器产物）：
 * 把 vision/describe 与 vision/save 两个端点装进 ctx.remote.vision 命名空间。
 * 宿主的 VisionRemoteService 走 SRC（源反射）模式，参数名与这里声明的 wire 名一致。
 */
import { z } from 'zod'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

const visionCatalogModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  vision: z.boolean().optional(),
})

const visionCatalogGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  models: z.array(visionCatalogModelSchema),
})

const visionCatalogFailureSchema = z.object({
  id: z.string(),
  name: z.string(),
  message: z.string(),
})

export const visionDescribeResultSchema = z.object({
  enabled: z.boolean(),
  provider: z.string(),
  model: z.string(),
  configured: z.boolean(),
  groups: z.array(visionCatalogGroupSchema),
  failures: z.array(visionCatalogFailureSchema),
})

export const visionSaveRequestSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
})

export const visionAdmissionRequestSchema = z.object({
  sessionId: z.string(),
})

export const visionAdmissionResultSchema = z.object({
  allowed: z.boolean(),
  patched: z.boolean(),
})

/** describe/save/ensureImageAdmission 的返回值与宿主侧一一对应。 */
export type VisionDescribeResult = z.infer<typeof visionDescribeResultSchema>
export type VisionSaveRequest = z.infer<typeof visionSaveRequestSchema>
export type VisionAdmissionRequest = z.infer<typeof visionAdmissionRequestSchema>
export type VisionAdmissionResult = z.infer<typeof visionAdmissionResultSchema>

export const VISION_TYPERT_REMOTE: TypertRemoteContribution = {
  package: 'dsh-vision-tool',
  descriptors: [
    {
      id: 'dsh-vision-tool#vision/describe',
      service: 'vision',
      namespace: 'vision',
      method: 'describe',
      invocation: { kind: 'direct' },
      parameters: [],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-vision-tool#vision/describe:result',
        schema: visionDescribeResultSchema,
      },
    },
    {
      id: 'dsh-vision-tool#vision/save',
      service: 'vision',
      namespace: 'vision',
      method: 'save',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'dsh-vision-tool#vision/save:request',
            schema: visionSaveRequestSchema,
          },
        },
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-vision-tool#vision/save:result',
        schema: visionDescribeResultSchema,
      },
    },
    {
      id: 'dsh-vision-tool#vision/ensureImageAdmission',
      service: 'vision',
      namespace: 'vision',
      method: 'ensureImageAdmission',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'dsh-vision-tool#vision/ensureImageAdmission:request',
            schema: visionAdmissionRequestSchema,
          },
        },
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-vision-tool#vision/ensureImageAdmission:result',
        schema: visionAdmissionResultSchema,
      },
    },
  ],
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'vision/describe': (signal?: AbortSignal) => Promise<RemoteResult<VisionDescribeResult>>
    'vision/save': (request: VisionSaveRequest, signal?: AbortSignal) => Promise<RemoteResult<VisionDescribeResult>>
    'vision/ensureImageAdmission': (
      request: VisionAdmissionRequest,
      signal?: AbortSignal,
    ) => Promise<RemoteResult<VisionAdmissionResult>>
  }
  interface TypertRemoteNamespaceMap {
    vision: {
      describe: (signal?: AbortSignal) => Promise<RemoteResult<VisionDescribeResult>>
      save: (request: VisionSaveRequest, signal?: AbortSignal) => Promise<RemoteResult<VisionDescribeResult>>
      ensureImageAdmission: (
        request: VisionAdmissionRequest,
        signal?: AbortSignal,
      ) => Promise<RemoteResult<VisionAdmissionResult>>
    }
  }
}
