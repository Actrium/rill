# CLI Build Tools

Rill provides a CLI for building and analyzing guest bundles. The CLI is distributed with the `rill` package and can be invoked via `bunx rill`.

---

## `rill build`

Compiles a guest React component into a self-contained bundle suitable for sandbox execution.

### Usage

```bash
bunx rill build src/guest.tsx -o dist/bundle.js
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `--watch` | boolean | `false` | Re-build on source changes |
| `--no-minify` | boolean | `false` | Disable minification |
| `--sourcemap` | boolean | `false` | Emit source maps alongside the bundle |
| `--format` | string | `cjs` | Output module format |
| `--strict` | boolean | `true` | Enable the dependency guard check |

### How It Works

1. **Bun.build** -- The build step delegates to `Bun.build` under the hood for fast, native-speed bundling.
2. **Externals** -- The following modules are automatically externalized and never included in the output bundle: `react`, `react-native`, `rill/guest`, and their sub-paths. These are provided at runtime by the host engine's `injectRuntimeAPI` step.
3. **Post-processing wrapper** -- After bundling, the output is wrapped with a thin runtime injection shim so that the sandbox can supply the externalized modules when the bundle executes.
4. **Strict dependency guard** -- When `--strict` is enabled (the default), the build scans the resolved dependency graph and fails if any module outside the allowed whitelist is referenced. This prevents accidental inclusion of Node built-ins, native addons, or other packages that would break inside the sandbox.

---

## `rill analyze`

A static analysis pass that scans a previously built bundle for security violations.

### Usage

```bash
bunx rill analyze dist/bundle.js
```

### What It Detects

- **Unauthorized requires** -- Any `require()` or `import` call targeting a module not in the whitelist.
- **eval usage** -- Direct or indirect use of `eval`, `Function()`, or `new Function()`.
- **Dynamic non-literal imports** -- Expressions like `require(variable)` or `import(expr)` where the specifier is not a static string literal.

The command exits with a non-zero status code when any violation is found, making it suitable for CI pipelines.

---

## Programmatic API

Both commands are also available as functions for integration into custom build scripts or tooling.

```ts
import { build, analyze } from 'rill/cli';

// Build a guest bundle
await build({
  entry: 'src/guest.tsx',
  outfile: 'dist/bundle.js',
  minify: true,
  sourcemap: false,
  watch: false,
  strict: true,
});

// Analyze the output for security violations
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

| Parameter | Type | Required | Description |
|---|---|---|---|
| `entry` | `string` | Yes | Path to the guest entry file |
| `outfile` | `string` | Yes | Output bundle path |
| `minify` | `boolean` | No | Minify the output (default `true`) |
| `sourcemap` | `boolean` | No | Emit source maps (default `false`) |
| `watch` | `boolean` | No | Watch mode (default `false`) |
| `strict` | `boolean` | No | Dependency guard (default `true`) |

Returns a `Promise<BuildResult>` that resolves when the build completes (or, in watch mode, when the initial build completes).

### `analyze(bundlePath, options)`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `bundlePath` | `string` | Yes | Path to the bundle to analyze |
| `options.whitelist` | `string[]` | No | Allowed module specifiers |
| `options.failOnViolation` | `boolean` | No | Throw on first violation (default `true`) |

Returns a `Promise<AnalyzeResult>` containing the list of detected violations.
