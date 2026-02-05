# 贡献指南

感谢你对 Rill 的兴趣！

[English Version](./CONTRIBUTING.md)

## 开发环境要求

- **Bun**: >= 1.0.0
- **Node.js**: >= 18.0.0

## 快速开始

```bash
# 克隆仓库
git clone https://github.com/GoAskAway/rill.git
cd rill

# 安装依赖
bun install

# 运行测试
npm run test:all

# 类型检查
bun run typecheck

# 代码检查
bun run lint
```

## 开发流程

### 1. 创建分支

```bash
git checkout -b feature/your-feature-name
# 或
git checkout -b fix/your-bug-fix
```

### 2. 进行更改

- 遵循现有代码风格
- 添加必要的类型定义
- 更新相关文档

### 3. 测试更改

```bash
# 所有测试 (单元 + Native + E2E)
npm run test:all

# 仅单元测试
npm test

# 类型检查
bun run typecheck

# 代码检查
bun run lint
```

### 4. 提交更改

```bash
git add .
git commit -m "feat: add new feature"
```

提交信息格式：
- `feat:` 新功能
- `fix:` 修复问题
- `docs:` 文档更新
- `refactor:` 代码重构
- `test:` 添加测试
- `chore:` 构建/工具更改

### 5. 推送并创建 PR

```bash
git push origin feature/your-feature-name
```

然后在 GitHub 上创建 Pull Request。

## 项目结构

```
rill/
├── src/
│   ├── runtime/        # Host 运行时 (Engine, Receiver)
│   ├── let/            # Guest SDK (组件、Hooks)
│   ├── bridge/         # 共享序列化层
│   ├── sandbox/        # 沙箱提供者
│   ├── cli/            # CLI 构建工具
│   ├── devtools/       # 开发工具
│   └── presets/        # 平台预设 (RN, Web)
├── native/
│   ├── jsc/            # JavaScriptCore 沙箱 (macOS/iOS)
│   ├── quickjs/        # QuickJS 沙箱 (跨平台)
│   └── platform/       # React Native 集成
├── tests/
│   ├── wasm-sandbox/           # WASM 沙箱 E2E 测试
│   └── rn-macos-bridgeless/    # React Native macOS E2E 测试 (Bridgeless)
└── docs/               # 文档
```

## 代码规范

### TypeScript

- 启用严格模式
- 禁止隐式 any
- 使用 Biome 进行格式化和检查

### 命名规范

- 文件名: `kebab-case.ts`
- 类型/接口: `PascalCase`
- 函数/变量: `camelCase`
- 常量: `UPPER_SNAKE_CASE`

## 需要帮助？

- [项目文档](../README.md)
- [报告问题](https://github.com/GoAskAway/rill/issues)
