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
| `-o, --outfile <path>` | string | `dist/bundle.js` | Output file path |
| `--no-minify` | boolean | (minify on) | Disable minification |
| `--sourcemap` | boolean | `false` | Emit an external source map alongside the bundle |
| `--watch` | boolean | `false` | Watch mode. **Currently a stub**: prints a notice and returns without building |
| `--metafile <path>` | string | -- | Write build metadata to a file |
| `--contract <path>` | string | -- | Contract module path (must export `contract` or a default contract) |
| `--capability-manifest <path>` | string | -- | Write the host capability manifest to a file |
| `--no-strict` | boolean | (strict on) | Disable the post-build dependency guard (not recommended) |
| `--strict-peer-versions` | boolean | `false` | Fail the build if React/reconciler versions mismatch the recommended matrix |
| `--footer <path>` | string | -- | Custom footer file (replaces the default auto-render footer) |
| `--dev` | boolean | `false` | Dev mode: inject source locations for DevTools navigation |

The output module format is always CommonJS -- `format: 'cjs'` is hard-coded in the underlying `Bun.build` call; there is no `--format` option.

### How It Works

1. **Bun.build** -- The build step delegates to `Bun.build` under the hood for fast, native-speed bundling.
2. **Externals** -- The following module IDs are externalized and never included in the output bundle: `react`, `react/jsx-runtime`, `react/jsx-dev-runtime`, `react-native`, `rill/guest`, and `host:*` capability modules. These are provided at runtime by the host engine's `injectRuntimeAPI` step.
3. **Post-processing wrapper** -- After bundling, the output is wrapped with a thin runtime injection shim so that the sandbox can supply the externalized modules when the bundle executes.
4. **Strict dependency guard** -- Unless `--no-strict` is passed, the build scans the output bundle and fails if any module outside the allowed whitelist is referenced. This prevents accidental inclusion of Node built-ins, native addons, or other packages that would break inside the sandbox.

---

## `rill analyze`

A static analysis pass that scans a previously built bundle for disallowed runtime dependencies and (optionally) contract boundary violations.

### Usage

```bash
bunx rill analyze dist/bundle.js --fail-on-violation
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `-w, --whitelist <mods...>` | string[] | `react`, `react-native`, `react/jsx-runtime`, `rill/guest` | Whitelisted module IDs |
| `--contract <path>` | string | -- | Contract module path; enables boundary validation against the contract |
| `--fail-on-violation` | boolean | `false` | Exit non-zero when violations are found |
| `--treat-eval-as-violation` | boolean | `false` | Count `eval()` usage as a violation |
| `--treat-dynamic-non-literal-as-violation` | boolean | `false` | Count dynamic imports with non-literal specifiers as violations |

### What It Detects

- **Non-whitelisted modules** (always) -- Any `require()` or `import` targeting a module outside the whitelist (relative paths, `host:*` modules, and URL-like specifiers are exempt).
- **eval usage** (opt-in) -- Counted as a violation only when `--treat-eval-as-violation` is passed.
- **Dynamic non-literal imports** (opt-in) -- Expressions like `import(expr)` with a non-literal specifier; counted as a violation only when `--treat-dynamic-non-literal-as-violation` is passed.
- **Contract boundary violations** (when `--contract` is given) -- `host:*` imports and guest exports are validated against the contract.

By default, violations are printed as **warnings and the command still exits with status 0**. Pass `--fail-on-violation` to make the command exit non-zero -- this is what you want in CI pipelines.

---

## `rill init`

Scaffolds a new guest project: creates `package.json`, a strict `tsconfig.json`, and a minimal `src/guest.tsx`.

```bash
bunx rill init my-rill-guest
```

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

// Analyze the output; throw on violations
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
| `minify` | `boolean` | Yes | Minify the output |
| `sourcemap` | `boolean` | Yes | Emit an external source map |
| `watch` | `boolean` | Yes | Watch mode (currently a stub: logs a notice and returns) |
| `strict` | `boolean` | No | Post-build dependency guard (default `true`) |
| `strictPeerVersions` | `boolean` | No | Fail on React/reconciler version mismatch (default `false`) |
| `metafile` | `string` | No | Build metadata output path |
| `contract` / `contractFile` | object / `string` | No | Contract object, or path to a contract module |
| `capabilityManifest` | `string` | No | Capability manifest output path |
| `footer` | `string` | No | Custom footer file path |
| `dev` | `boolean` | No | Inject source locations for DevTools (default `false`) |

Returns `Promise<void>`; it resolves when the build completes and rejects on failure.

### `analyze(bundlePath, options)`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `bundlePath` | `string` | Yes | Path to the bundle to analyze |
| `options.whitelist` | `string[]` | No | Allowed module specifiers (default: `react`, `react-native`, `react/jsx-runtime`, `rill/guest`) |
| `options.failOnViolation` | `boolean` | No | Throw when violations are found (default `false` -- violations are logged as warnings) |
| `options.treatEvalAsViolation` | `boolean` | No | Count `eval()` usage as a violation (default `false`) |
| `options.treatDynamicNonLiteralAsViolation` | `boolean` | No | Count non-literal dynamic imports as violations (default `false`) |
| `options.contract` / `options.contractFile` | object / `string` | No | Contract for boundary validation |

Returns a `Promise<AnalyzeResult>` containing the detected modules, host capabilities, guest exports, and the list of violations.
