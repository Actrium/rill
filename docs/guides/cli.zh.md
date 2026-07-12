# CLI 构建工具

Rill 提供了一个用于构建和分析 guest bundle 的 CLI。该 CLI 与 `rill` 包一起分发,可通过 `bunx rill` 调用。

---

## `rill build`

将 guest React 组件编译成适合在沙箱中执行的自包含 bundle。

### 用法

```bash
bunx rill build src/guest.tsx -o dist/bundle.js
```

### 选项

| 选项 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `-o, --outfile <path>` | string | `dist/bundle.js` | 输出文件路径 |
| `--no-minify` | boolean | (默认开启压缩) | 禁用压缩 |
| `--sourcemap` | boolean | `false` | 在 bundle 旁生成外部 source map |
| `--watch` | boolean | `false` | 监听模式。**目前是桩实现**:仅打印提示后直接返回,不执行构建 |
| `--metafile <path>` | string | -- | 将构建元数据写入文件 |
| `--contract <path>` | string | -- | 契约模块路径(需导出 `contract` 或默认契约) |
| `--capability-manifest <path>` | string | -- | 将 host 能力清单写入文件 |
| `--no-strict` | boolean | (默认开启 strict) | 禁用构建后依赖守卫(不推荐) |
| `--strict-peer-versions` | boolean | `false` | React/reconciler 版本与推荐矩阵不匹配时构建失败 |
| `--footer <path>` | string | -- | 自定义 footer 文件(替换默认的自动渲染 footer) |
| `--dev` | boolean | `false` | 开发模式:注入源码位置以支持 DevTools 导航 |

输出模块格式始终为 CommonJS -- 底层 `Bun.build` 调用中硬编码了 `format: 'cjs'`,不存在 `--format` 选项。

### 工作原理

1. **Bun.build** -- 构建步骤在底层委托给 `Bun.build`,实现快速的原生速度打包。
2. **外部化** -- 以下模块 ID 会被外部化,永不包含在输出 bundle 中:`react`、`react/jsx-runtime`、`react/jsx-dev-runtime`、`react-native`、`rill/guest` 以及 `host:*` 能力模块。这些模块由 host engine 的 `injectRuntimeAPI` 步骤在运行时提供。
3. **后处理包装器** -- 打包后,输出会被包装在一个轻量的运行时注入 shim 中,以便沙箱在 bundle 执行时提供外部化的模块。
4. **严格依赖守卫** -- 除非传入 `--no-strict`,构建会扫描输出 bundle,如果引用了允许白名单之外的任何模块,则构建失败。这可防止意外包含 Node 内置模块、原生插件或其他会在沙箱内崩溃的包。

---

## `rill analyze`

静态分析步骤,扫描先前构建的 bundle 以查找不允许的运行时依赖,以及(可选)契约边界违规。

### 用法

```bash
bunx rill analyze dist/bundle.js --fail-on-violation
```

### 选项

| 选项 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `-w, --whitelist <mods...>` | string[] | `react`、`react-native`、`react/jsx-runtime`、`rill/guest` | 白名单模块 ID |
| `--contract <path>` | string | -- | 契约模块路径;启用针对契约的边界校验 |
| `--fail-on-violation` | boolean | `false` | 发现违规时以非零状态码退出 |
| `--treat-eval-as-violation` | boolean | `false` | 将 `eval()` 使用计为违规 |
| `--treat-dynamic-non-literal-as-violation` | boolean | `false` | 将非字面量指定符的动态导入计为违规 |

### 检测内容

- **白名单外模块**(始终检测)-- 任何针对白名单之外模块的 `require()` 或 `import`(相对路径、`host:*` 模块和 URL 形式的指定符除外)。
- **eval 使用**(需显式开启)-- 仅在传入 `--treat-eval-as-violation` 时才计为违规。
- **动态非字面量导入**(需显式开启)-- 像 `import(expr)` 这样指定符非字面量的表达式;仅在传入 `--treat-dynamic-non-literal-as-violation` 时才计为违规。
- **契约边界违规**(传入 `--contract` 时)-- 根据契约校验 `host:*` 导入和 guest 导出。

默认情况下,违规只会**以警告形式打印,命令仍以状态码 0 退出**。传入 `--fail-on-violation` 才会使命令以非零状态码退出 -- CI 流水线中应使用该选项。

---

## `rill init`

初始化一个新的 guest 项目:创建 `package.json`、严格的 `tsconfig.json` 和一个最小化的 `src/guest.tsx`。

```bash
bunx rill init my-rill-guest
```

---

## 编程 API

两个命令也可作为函数使用,以集成到自定义构建脚本或工具中。

```ts
import { build, analyze } from 'rill/cli';

// 构建 guest bundle
await build({
  entry: 'src/guest.tsx',
  outfile: 'dist/bundle.js',
  minify: true,
  sourcemap: false,
  watch: false,
  strict: true,
});

// 分析输出;发现违规时抛出错误
await analyze('dist/bundle.js', {
  whitelist: [
    'react',
    'react-native',
    'react/jsx-runtime',
    'rill/guest',
  ],
  failOnViolation: true,
});
```

### `build(options)`

| 参数 | 类型 | 必需 | 描述 |
|---|---|---|---|
| `entry` | `string` | 是 | guest 入口文件路径 |
| `outfile` | `string` | 是 | 输出 bundle 路径 |
| `minify` | `boolean` | 是 | 压缩输出 |
| `sourcemap` | `boolean` | 是 | 生成外部 source map |
| `watch` | `boolean` | 是 | 监听模式(目前是桩实现:打印提示后直接返回) |
| `strict` | `boolean` | 否 | 构建后依赖守卫(默认 `true`) |
| `strictPeerVersions` | `boolean` | 否 | React/reconciler 版本不匹配时失败(默认 `false`) |
| `metafile` | `string` | 否 | 构建元数据输出路径 |
| `contract` / `contractFile` | object / `string` | 否 | 契约对象,或契约模块路径 |
| `capabilityManifest` | `string` | 否 | 能力清单输出路径 |
| `footer` | `string` | 否 | 自定义 footer 文件路径 |
| `dev` | `boolean` | 否 | 注入源码位置以支持 DevTools(默认 `false`) |

返回 `Promise<void>`;构建完成时 resolve,失败时 reject。

### `analyze(bundlePath, options)`

| 参数 | 类型 | 必需 | 描述 |
|---|---|---|---|
| `bundlePath` | `string` | 是 | 要分析的 bundle 路径 |
| `options.whitelist` | `string[]` | 否 | 允许的模块指定符(默认:`react`、`react-native`、`react/jsx-runtime`、`rill/guest`) |
| `options.failOnViolation` | `boolean` | 否 | 发现违规时抛出错误(默认 `false` -- 违规仅记录为警告) |
| `options.treatEvalAsViolation` | `boolean` | 否 | 将 `eval()` 使用计为违规(默认 `false`) |
| `options.treatDynamicNonLiteralAsViolation` | `boolean` | 否 | 将非字面量动态导入计为违规(默认 `false`) |
| `options.contract` / `options.contractFile` | object / `string` | 否 | 用于边界校验的契约 |

返回 `Promise<AnalyzeResult>`,包含检测到的模块、host 能力、guest 导出以及违规列表。
