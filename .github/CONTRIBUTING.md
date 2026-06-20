# Contributing Guide

Thank you for your interest in contributing to Rill!

[中文版本](./CONTRIBUTING.zh.md)

## Development Environment

- **Bun**: >= 1.0.0
- **Node.js**: >= 18.0.0

## Quick Start

```bash
# Clone the repository
git clone https://github.com/GoAskAway/rill.git
cd rill

# Install dependencies
bun install

# Run tests
npm run test:all

# Type check
bun run typecheck

# Lint
bun run lint
```

## Development Workflow

### 1. Create a Branch

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/your-bug-fix
```

### 2. Make Changes

- Follow existing code style
- Add necessary type definitions
- Update relevant documentation

### 3. Test Changes

```bash
# All tests (unit + native + E2E)
npm run test:all

# Unit tests only
npm test

# Type checking
bun run typecheck

# Lint
bun run lint
```

### 4. Commit Changes

```bash
git add .
git commit -m "feat: add new feature"
```

Commit message format:
- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation update
- `refactor:` Code refactoring
- `test:` Add tests
- `chore:` Build/tooling changes

### 5. Push and Create PR

```bash
git push origin feature/your-feature-name
```

Then create a Pull Request on GitHub.

## Project Structure

```
rill/
├── src/
│   ├── runtime/        # Host runtime (Engine, Receiver)
│   ├── let/            # Guest SDK (components, hooks)
│   ├── bridge/         # Shared serialization layer
│   ├── sandbox/        # Sandbox providers
│   ├── cli/            # CLI build tools
│   ├── devtools/       # Development tools
│   └── presets/        # Platform presets (RN, Web)
├── native/
│   ├── jsc/            # JavaScriptCore sandbox (macOS/iOS)
│   ├── quickjs/        # QuickJS sandbox (cross-platform)
│   └── platform/       # React Native integration
├── tests/
│   ├── wasm-sandbox/           # WASM sandbox E2E tests
│   └── rn-macos-bridgeless/    # React Native macOS E2E tests (Bridgeless)
└── docs/               # Documentation
```

## Code Standards

### TypeScript

- Strict mode enabled
- No implicit any
- Use Biome for formatting and linting

### Naming Conventions

- File names: `kebab-case.ts`
- Types/Interfaces: `PascalCase`
- Functions/Variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE`

## Need Help?

- [Documentation](../README.md)
- [Report Issues](https://github.com/GoAskAway/rill/issues)
