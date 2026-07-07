# Rill Documentation

Rill is a lightweight, headless, sandboxed dynamic UI rendering engine for React Native that runs React components in isolated sandbox environments and streams render results to the host application.

## Documentation Structure

| Section | Contents |
|---------|----------|
| [Getting Started](./getting-started/) | [Quick Start](./getting-started/) / [Host Integration](./getting-started/host-integration.md) / [Guest Development](./getting-started/guest-development.md) |
| [Guides](./guides/) | [CLI](./guides/cli.md) / [Sandbox Providers](./guides/sandbox-providers.md) / [Native Integration](./guides/native-integration.md) / [Multi-Tenant](./guides/multi-tenant.md) / [Production](./guides/production.md) / [Host Module Types](./guides/host-module-types.md) |
| [API](./api/) | [API Overview](./api/) / [Host API](./api/host.md) / [Guest SDK](./api/sdk.md) / [TenantManager API](./api/tenant-manager.md) |
| [Architecture](./architecture/) | [Overview](./architecture/) / [Guest-Host Interaction](./architecture/guest-host-interaction.md) / [Guest Runtime](./architecture/guest-runtime.md) / [Bridge Serialization](./architecture/bridge-serialization.md) / [Native TenantManager](./architecture/native-tenant-manager.md) / [Binary Protocol](./architecture/binary-protocol.md) / [Security](./architecture/security.md) / [Event Bus](./architecture/event-bus.md) / [CDP Debugging](./architecture/cdp-debugging.md) |
| [Reference](./reference/) | [Sandbox Comparison](./reference/sandbox-comparison.md) |

## Audience Guide

- **Guest developers** -- Build dynamic UI components that run inside Rill sandboxes. Start with [Quick Start](./getting-started/) and [Guest Development](./getting-started/guest-development.md), then refer to the [Guest SDK](./api/sdk.md).

- **Host integrators** -- Embed the Rill engine into a React Native application. See [Host Integration](./getting-started/host-integration.md), the [Host API](./api/host.md), and the [Sandbox Providers](./guides/sandbox-providers.md) guide.

- **Architecture contributors** -- Understand or extend Rill internals. The [Architecture](./architecture/) section covers the guest-host boundary, bridge serialization, binary protocol, and native tenant manager design.

- **Operations** -- Deploy and operate Rill in production. Refer to [Multi-Tenant](./guides/multi-tenant.md), [Production](./guides/production.md), and [Security](./architecture/security.md).
