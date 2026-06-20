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
| `--watch` | boolean | `false` | 源代码变更时重新构建 |
| `--no-minify` | boolean | `false` | 禁用压缩 |
| `--sourcemap` | boolean | `false` | 在 bundle 旁生成 source map |
| `--format` | string | `cjs` | 输出模块格式 |
| `--strict` | boolean | `true` | 启用依赖守卫检查 |

### 工作原理

1. **Bun.build** -- 构建步骤在底层委托给 `Bun.build`,实现快速的原生速度打包。
2. **外部化** -- 以下模块会自动外部化,永不包含在输出 bundle 中:`react`、`react-native`、`rill/guest` 及其子路径。这些模块由 host engine 的 `injectRuntimeAPI` 步骤在运行时提供。
3. **后处理包装器** -- 打包后,输出会被包装在一个轻量的运行时注入 shim 中,以便沙箱在 bundle 执行时提供外部化的模块。
4. **严格依赖守卫** -- 当启用 `--strict`(默认)时,构建会扫描解析的依赖图,如果引用了允许白名单之外的任何模块,则构建失败。这可防止意外包含 Node 内置模块、原生插件或其他会在沙箱内崩溃的包。

---

## `rill analyze`

静态分析步骤,扫描先前构建的 bundle 以查找安全违规。

### 用法

```bash
bunx rill analyze dist/bundle.js
```

### 检测内容

- **未授权的 require** -- 任何针对白名单之外模块的 `require()` 或 `import` 调用。
- **eval 使用** -- 直接或间接使用 `eval`、`Function()` 或 `new Function()`。
- **动态非字面量导入** -- 像 `require(variable)` 或 `import(expr)` 这样的表达式,其中指定符不是静态字符串字面量。

当发现任何违规时,命令会以非零状态码退出,适合用于 CI 流水线。

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

// 分析输出以查找安全违规
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
| `minify` | `boolean` | 否 | 压缩输出(默认 `true`) |
| `sourcemap` | `boolean` | 否 | 生成 source map(默认 `false`) |
| `watch` | `boolean` | 否 | 监听模式(默认 `false`) |
| `strict` | `boolean` | 否 | 依赖守卫(默认 `true`) |

返回一个 `Promise<BuildResult>`,在构建完成时解析(或在监听模式下,在初始构建完成时解析)。

### `analyze(bundlePath, options)`

| 参数 | 类型 | 必需 | 描述 |
|---|---|---|---|
| `bundlePath` | `string` | 是 | 要分析的 bundle 路径 |
| `options.whitelist` | `string[]` | 否 | 允许的模块指定符 |
| `options.failOnViolation` | `boolean` | 否 | 遇到首个违规时抛出错误(默认 `true`) |

返回一个 `Promise<AnalyzeResult>`,包含检测到的违规列表。
