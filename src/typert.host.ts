/**
 * dsh-vision-tool 的 Typert 宿主清单（手写，等价于官方生成器产物）。
 *
 * dsh-typert-loader 在加载本包时读取 exports["./typert"] 的 TYPERT 导出，
 * 把 vision/describe、vision/save 的严格定义注册进 ctx.typert.local。
 * 网关因此走严格路径解析这两个端点 —— 不依赖 SRC 源反射。
 *
 * 为什么必须走严格路径：@Remote 装饰器把方法标记存在 dsh-typert-protocol 的
 * 模块私有状态里；插件自带 node_modules 时与网关持有的是两份模块实例，
 * SRC 反射读不到标记（404）。typert-loader 注册的严格定义没有这个问题。
 */
import { z } from 'zod'

const visionCatalogModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  vision: z.boolean(),
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

export const visionPersistFileRequestSchema = z.object({
  sessionId: z.string(),
  name: z.string(),
  mediaType: z.string(),
  data: z.string(),
})

export const visionPersistFileResultSchema = z.object({
  relPath: z.string(),
  size: z.number(),
  enabled: z.boolean(),
})

export const TYPERT = {
  package: 'dsh-vision-tool',
  face: 'host' as const,
  schemas: [],
  model: {
    services: [],
    events: [],
    objects: [],
  },
  invocations: [
    {
      id: 'dsh-vision-tool#vision/describe',
      service: 'vision',
      namespace: 'vision',
      method: 'describe',
      invocation: { kind: 'direct' as const },
      parameters: [],
      cancellation: { parameter: 'signal' as const },
      result: {
        mode: 'strict' as const,
        typeSymbol: 'dsh-vision-tool#vision/describe:result',
        schema: visionDescribeResultSchema,
      },
    },
    {
      id: 'dsh-vision-tool#vision/save',
      service: 'vision',
      namespace: 'vision',
      method: 'save',
      invocation: { kind: 'direct' as const },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json' as const,
          codec: {
            mode: 'strict' as const,
            typeSymbol: 'dsh-vision-tool#vision/save:request',
            schema: visionSaveRequestSchema,
          },
        },
      ],
      cancellation: { parameter: 'signal' as const },
      result: {
        mode: 'strict' as const,
        typeSymbol: 'dsh-vision-tool#vision/save:result',
        schema: visionDescribeResultSchema,
      },
    },
    {
      id: 'dsh-vision-tool#vision/persistFile',
      service: 'vision',
      namespace: 'vision',
      method: 'persistFile',
      invocation: { kind: 'direct' as const },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json' as const,
          codec: {
            mode: 'strict' as const,
            typeSymbol: 'dsh-vision-tool#vision/persistFile:request',
            schema: visionPersistFileRequestSchema,
          },
        },
      ],
      cancellation: { parameter: 'signal' as const },
      result: {
        mode: 'strict' as const,
        typeSymbol: 'dsh-vision-tool#vision/persistFile:result',
        schema: visionPersistFileResultSchema,
      },
    },
    {
      id: 'dsh-vision-tool#vision/ensureImageAdmission',
      service: 'vision',
      namespace: 'vision',
      method: 'ensureImageAdmission',
      invocation: { kind: 'direct' as const },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json' as const,
          codec: {
            mode: 'strict' as const,
            typeSymbol: 'dsh-vision-tool#vision/ensureImageAdmission:request',
            schema: visionAdmissionRequestSchema,
          },
        },
      ],
      cancellation: { parameter: 'signal' as const },
      result: {
        mode: 'strict' as const,
        typeSymbol: 'dsh-vision-tool#vision/ensureImageAdmission:result',
        schema: visionAdmissionResultSchema,
      },
    },
  ],
}
