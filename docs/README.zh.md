# Rill 文档

Rill 是一个轻量级、无界面、沙箱化的动态 UI 渲染引擎，用于 React Native，它在隔离的沙箱环境中运行 React 组件，并将渲染结果流式传输到宿主应用程序。

## 文档结构

| 章节 | 内容 |
|---------|----------|
| [快速开始](./getting-started/README.zh.md) | [快速开始](./getting-started/README.zh.md) / [宿主集成](./getting-started/host-integration.zh.md) / [访客开发](./getting-started/guest-development.zh.md) |
| [指南](./guides/cli.zh.md) | [CLI](./guides/cli.zh.md) / [沙箱提供者](./guides/sandbox-providers.zh.md) / [原生集成](./guides/native-integration.zh.md) / [多租户](./guides/multi-tenant.zh.md) / [生产环境](./guides/production.zh.md) / [Host 模块类型](./guides/host-module-types.zh.md) |
| [API](./api/README.zh.md) | [API 概览](./api/README.zh.md) / [Host API](./api/host.zh.md) / [Guest SDK](./api/sdk.zh.md) / [TenantManager API](./api/tenant manager.zh.md) |
| [架构](./architecture/README.zh.md) | [概览](./architecture/README.zh.md) / [访客-宿主交互](./architecture/guest-host-interaction.zh.md) / [访客运行时](./architecture/guest-runtime.zh.md) / [桥接序列化](./architecture/bridge-serialization.zh.md) / [原生编排器](./architecture/native-tenant-manager.zh.md) / [二进制协议](./architecture/binary-protocol.zh.md) / [安全性](./architecture/security.zh.md) / [事件总线](./architecture/event-bus.zh.md) / [CDP 调试](./architecture/cdp-debugging.zh.md) |
| [参考](./reference/sandbox-comparison.zh.md) | [沙箱对比](./reference/sandbox-comparison.zh.md) |

## 受众指南

- **访客开发者** -- 构建在 Rill 沙箱内运行的动态 UI 组件。从[快速开始](./getting-started/README.zh.md)和[访客开发](./getting-started/guest-development.zh.md)开始，然后参考 [Guest SDK](./api/sdk.zh.md)。

- **宿主集成者** -- 将 Rill 引擎嵌入到 React Native 应用程序中。请参阅[宿主集成](./getting-started/host-integration.zh.md)、[Host API](./api/host.zh.md) 和[沙箱提供者](./guides/sandbox-providers.zh.md)指南。

- **架构贡献者** -- 理解或扩展 Rill 内部机制。[架构](./architecture/README.zh.md)章节涵盖了访客-宿主边界、桥接序列化、二进制协议和原生编排器设计。

- **运维人员** -- 在生产环境中部署和运营 Rill。请参考[多租户](./guides/multi-tenant.zh.md)、[生产环境](./guides/production.zh.md)和[安全性](./architecture/security.zh.md)。
