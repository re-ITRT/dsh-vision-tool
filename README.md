# dsh-vision-tool

DeepSeek Harness 的视觉工具插件（Cordis 插件）：给 agent 增加 **一条提示词 + 一个工具**，
并在 Web 设置面板里提供与官方「模型」页同源数据、同款下拉框的 **视觉模型选择页**。

对 agent 的最终效果：

1. **提示词** —— 通过 `ctx.systemPrompt.section` 注入一条工具引导段（order 150，工具引导区）；
2. **工具** —— 注册 `vision_analyze`（👁️），模型调用它时把图片加载进会话：
   - 当前模型自带视觉 → 图片直接挂进 agent 上下文（下一轮模型自己读像素）；
   - 无原生视觉 → 回退到视觉页选定的模型，把图片的文字描述作为工具结果返回。

**只有选择过视觉模型（provider + model 都非空）时工具才注册**；未配置时 agent 上下文里
完全看不到 `vision_analyze`，引导段也会自动从提示词里消失。设置页选择后即时生效，无需重启。

## 视觉辅助总开关

设置页顶部是 **「视觉辅助（Vision assist）」总开关**，控制插件的整体行为：

| 开关 | 行为 |
| --- | --- |
| **关** | 与未安装插件完全一致：不注册工具、不注入提示词、不转换图片 —— 无视觉功能的模型收到图片会走 DSH 默认拒绝（`MODEL_DOES_NOT_SUPPORT_IMAGES`） |
| **开** | ① **用户直传图**：提交前把图片交给视觉模型生成文字描述，替换后进入会话 —— 无论主模型有无原生视觉都能"看到"图片；② **运行时图**：agent 工具产生的图片（截图/文件）由 pre-step 拦截器转换；③ `vision_analyze` 工具注册，agent 可自行决定查看图片/裁剪区域 |

两条转换路径共用同一套描述逻辑（提示词模板 + 所选视觉模型），任一张图转换失败时
消息保持原样并显示明确错误，绝不吞掉用户输入。

---

## 视觉模型页面

打开 Web UI → 设置 → **👁️ 视觉 / Vision**：

- **模型下拉框**：与对话框右下角的模型选择器同源（模型目录），按提供方分组列出模型；
  带 👁️ 的模型已声明图片输入。
- **选择即保存**：点选后写入 vision 命名空间，工具立即上线/下线。
- **图片能力自动声明**：OpenAI 兼容路由（llm-pi-ai）的模型默认按纯文本对待 —— 选择后
  本插件自动写入 `providers.<provider>.modelOverrides.<model>.input: [text, image]`
  （等价于官方「配置模型」指南里的手写声明），切换/清空选择时自动清理。
- **目录外模型**：下拉框底部提供「手动输入模型 ID…」（provider + model）。
- 官方「模型」页**不会**出现任何 Vision 相关条目：视觉配置只存在于本页面。
  端点和密钥仍由「模型」页统一管理，视觉页只是从已有提供方里选模型。

## 工具规格

注册信息：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| name | `vision_analyze` | 工具注册名 |
| toolset | `vision` | 分组名。当前 DSH rc.6 的 `ToolDefinition` 没有 toolset 字段，这里作为插件内元数据 + 提示词引导段/设置页的分组呈现 |
| emoji | 👁️ | 纯装饰的显示图标：不进系统提示，不影响 LLM 调用；在 DSH 里通过工具调用卡片（`presentCall` 的 title）呈现。皮肤覆盖系统暂不实现 |

工具描述（description）与参数按需求方规格原样实现：

| 参数 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `image_url` | string | ✅ | Image URL (http/https), local file path, or data: URL to load. |
| `question` | string | ✅ | Your specific question or request about the image. |
| `region` | array (4 ints) | – | `[x1, y1, x2, y2]` 裁剪区域，坐标 clamp 到原图边界；**先裁剪、后缩小**，region 保持全分辨率 |

视觉调用提示词（发给所选视觉模型，`{question}` 被替换）：

> Fully describe and explain everything about this image, then answer the following question:
>
> {question}

---

## 工作原理（Cordis 框架）

### 宿主侧（`src/`）

- 插件形态：导出 `name` / `inject` / `apply(ctx, config)` 的函数式插件；
  `inject = ['tools', 'settings', 'llm', 'attachments', 'systemPrompt']`，
  依赖服务就绪后 apply 才执行。
- **设置命名空间**：`ctx.settings.register('vision', schema, { base })` 注册
  `{ provider, model }` 分节；`base` 来自 cordis.yml 的插件 config，用户层由设置页覆盖。
  该命名空间**不对外暴露**（不进 dsh-host-apiproxy 的 Web 白名单），只供宿主内部使用。
- **Typert Remote（`src/remote.ts`）**：`VisionRemoteService extends TypertRemoteService`，
  cordis 服务名 = 线上命名空间 = `vision`，两个 `@Remote` 方法构成端点
  `vision/describe`（当前选择 + 模型目录 + 每个模型的 vision 能力标记）与
  `vision/save`（写入选择）。这是设置页唯一的数据通道，绕开了设置白名单，也因此不污染「模型」页。
  **注意**：`@Remote` 装饰器把方法标记存在 `dsh-typert-protocol` 的模块私有状态里；
  插件自带 node_modules 时与网关持有两份模块实例，SRC 源反射会读不到标记（404）。
  因此 `src/typert.host.ts` 提供了严格路径清单（`exports["./typert"]`），
  `dsh-typert-loader` 把它注册进 `ctx.typert.local`，网关走严格路径解析这两个端点。
- **条件注册**：`scope.watch` 监听设置变化，provider+model 齐全才
  `ctx.tools.register(...)`，否则调用注册返回的 disposer 卸载工具（触发
  `tools/change`，提示词组装即时更新）。
- **图片能力同步**：设置变化时把 `modelOverrides.<model>.input: [text, image]`
  写入 llm-pi-ai 命名空间（只对 pi-ai 目录里的路由），切换/清空时清理旧声明。
- **执行链路**（`execute(args, exec)`）：
  1. 解析图片：data: URL 直接解码 / http(s) fetch / 本地路径读文件；
  2. sharp 处理：region 裁剪（clamp）→ 超 `maxDimension`（默认 1568）等比缩小 → 重编码；
  3. `ctx.attachments.saveImage` 落附件（DSH 的图片只会以附件引用进入会话）；
  4. 判断当前 agent 模型（`exec.agent.options` + `ctx.llm.resolveModelInfo`）是否声明
     `image` 模态：是 → `exec.deferContext` 把图片用户消息挂进上下文，返回短确认；
     否 → 按提示词模板组 `text + image` 用户消息，`ctx.llm.stream({ provider, model, ... })`
     调用**选定的视觉模型**，把文本描述作为工具结果返回。
- **清理**：所有注册都是 effect，插件卸载自动清理；条件注册的工具在 `ctx.effect` 的
  清理器里显式 dispose。

### 浏览器侧（`client/`，Web 设置页）

- package.json 声明 `dsh.client = { platform: 'web', inject: [...] }`，并在
  `exports["./client"]` 导出构建好的 bundle；宿主把 bundle 注入
  `window.__DSH_BOOT__`，浏览器侧经 `window.__ModuleLoader__.load({ id, factory })`
  注册成 client 插件。
- `client/remote.ts`：手写的 Typert Remote 客户端贡献（等价于官方生成器产物）——
  zod 严格 codec + `TypertRemoteMap`/`TypertRemoteNamespaceMap` 声明合并；
  `apply(ctx)` 里 `await ctx.remote.$mount(VISION_TYPERT_REMOTE)` 后即可用
  `ctx.remote.vision.describe()` / `ctx.remote.vision.save(...)`。
- `client/VisionSection.tsx`：`settings.section` 注册的设置页（与「模型」页同一个
  slot 机制）；模型下拉框用 `dsh-client-ui-primitives` 的 `Menu`（与对话框右下角
  模型选择器同一组件族），数据来自 `vision/describe` 的模型目录。

## 构建

\`\`\`sh
npm install
npm run build        # tsc 编译宿主侧到 lib/，esbuild 打包 client bundle 到 dist/client.js
npm run typecheck    # 宿主侧 + 客户端双 tsconfig 类型检查
\`\`\`

客户端 bundle 的构建方式（`scripts/build-client.mjs`）：esbuild 以 `format: 'cjs'`
打包 `client/index.tsx`，`react` / `@deepseek-ai/*` 全部 external —— 这些 id 在运行时
由 shell 的模块加载器提供；zod 会内联进 bundle —— 最后把产物包进
`window.__ModuleLoader__.load({ id: 'dsh-vision-tool', factory: (require) => {...} })`
外壳（与官方 client 包 tsdown 产物同构）。

## 加载

开发模式（直接加载 TS 源码，配合 `dsh-client-hmr` 可热重载）：

\`\`\`sh
npx @deepseek-ai/dsh web --patch cordis.yml.example
\`\`\`

其中 `cordis.yml` 内容：

\`\`\`yaml
- insert:
  - id: vision
    name: /absolute/path/to/dsh-vision-tool/src/index.ts   # 开发：绝对路径
    # name: dsh-vision-tool                                  # 安装后：包名
\`\`\`

已安装模式：在运行 dsh 的 profile 目录（cordis.yml 所在目录，即 `ctx.baseUrl`）执行
`npm i <本仓库路径>`，再用包名 `dsh-vision-tool` 插入组合。注意 client 扫描锚定在
cordis.yml 所在目录解析包，`exports["./client"]` 必须指向已构建的 `dist/client.js`。
修改插件集合后需要重启 dsh 服务（bundle 内容变更由 HMR 覆盖）。

## 配置（cordis.yml 的 config 段）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `provider` | – | 组合层默认视觉提供方路由（设置页可覆盖） |
| `model` | – | 组合层默认视觉模型 id（设置页可覆盖） |
| `namespace` | `vision` | 设置命名空间 |
| `maxDimension` | `1568` | 图像最长边，超出等比缩小（region 先裁剪） |
| `jpegQuality` | `90` | JPEG 编码质量 |
| `systemPrompt` | … | 视觉调用的 system prompt |
| `promptTemplate` | 需求方给定文案 | 视觉调用提示词模板，`{question}` 占位 |

## 目录结构

\`\`\`
dsh-vision-tool/
├── package.json            # dsh.client 声明 + exports["./client"]
├── tsconfig.json           # 宿主侧（NodeNext）
├── tsconfig.client.json    # 客户端（Bundler + react-jsx）
├── cordis.yml.example      # 插入组合的 patch 示例
├── scripts/build-client.mjs
├── src/                    # 宿主插件
│   ├── index.ts            # apply：设置注册 + Remote 挂载 + 条件工具注册 + 引导段
│   ├── config.ts           # Config 类型 + Schemastery schema
│   ├── settings.ts         # 'vision' 命名空间 + 图片能力声明同步
│   ├── remote.ts           # Typert Remote 服务（vision/describe、vision/save）
│   ├── tool.ts             # vision_analyze 定义与执行
│   └── image.ts            # URL/路径/dataURL 解析 + region 裁剪 + 缩小
├── client/                 # 浏览器插件（设置页）
│   ├── index.tsx           # remote 挂载 + settings.section 注册
│   ├── remote.ts           # 客户端 Remote 贡献（zod codec + 类型合并）
│   ├── store.ts            # 页面 store（describe/save 薄封装）
│   └── VisionSection.tsx   # 模型下拉框（Menu）+ 手动输入 + 状态点
├── lib/                    # tsc 产物（宿主侧）
└── dist/client.js          # esbuild 产物（客户端 bundle）
\`\`\`

## 实测验证（2026-08-14，DSH 0.1.0-rc.6）

在 `dsh web`（profile 安装模式）上完整跑通：

| 验证项 | 结果 |
| --- | --- |
| client bundle 注入 | `window.__DSH_BOOT__` 含 `dsh-vision-tool` row，`/plugins/dsh-vision-tool/client.js` 200 |
| 设置页 | 设置 → 👁️ 视觉 / Vision 正常渲染，无 JS 错误 |
| 模型下拉框 | 与右下角模型选择器同源：DeepSeek 官方 + opencode-go 全目录，带 👁️ 能力标记 |
| 选择即保存 | 选中 qwen3.7-plus → `~/.dsh/settings.yaml` 写入 `vision: {provider, model}` |
| 能力自动声明 | `llm-pi-ai.providers.opencode-go.modelOverrides.qwen3.7-plus.input: [text, image]` 自动落盘 |
| 条件注册（正向） | 配置后新会话 agent 实际调用 `vision_analyze`（URL 输入，21s 完成，返回详细中文描述） |
| 条件注册（反向） | 清空配置重启后，agent 明示工具列表里没有 vision_analyze、不具备图像能力 |
| region 裁剪 | `[100,150,600,400]`→500x250 精确；越界坐标 clamp；退化区域正确报错 |
| **总开关·关** | 上传图片发送 → prompt 返回 `attachment-error: Model "deepseek-v4-pro" does not support image input`，与原版一致 |
| **总开关·开** | 上传图片发送 → `vision/transformImages` 调 minimax-m3 生成描述 → 主模型（无原生视觉）收到完整图片描述并准确回答（背景色/图案/文字全对） |

## 已知边界

- 视觉能力探测基于 `resolveModelInfo` 报告的 `inputModalities`；目录未描述的模型
  显示为不带 👁️，选中后由图片能力声明补齐（仅 llm-pi-ai 路由）。
- 非 llm-pi-ai 适配器的路由（如 DeepSeek 官方纯文本路由）无法接收图片输入，
  选中后调用会得到适配器的明确报错。
- 皮肤/主题对工具 emoji 的覆盖系统按要求暂不实现；emoji 固定为注册时的 👁️。
