# 在 guest 工程里为 `host:*` 模块打类型

rill guest 以环境模块(ambient module)的形式引入宿主能力:

```ts
import { getText, putText } from 'host:store'
import { fetch } from 'host:net'
```

`host:*` 不是 npm 包 —— 它是宿主在运行时注入的能力。本文是给这些 import **打类型**的受支持约定,
让 guest 作者拿到编辑器补全、且 `tsc` 通过而**无需** `@ts-expect-error`。

## 类型只影响编辑器与类型检查 —— 从不影响构建

rill CLI(`cli/build.ts`)在打包期自己解析 `host:*` import,把它们留作运行时能力调用。这套解析
**与 TypeScript 类型无关**:无论有没有 `.d.ts`,guest 都能正确构建与运行。所以打类型纯属开发体验层面 ——
这里的一切都不改变 guest 如何编译或发布。

## 机制:环境声明 `declare module 'host:*'`

环境模块声明是给 `host:*` 打类型的**官方受支持**方式。宿主发布一份声明文件 ——
约定名为 `host-modules.d.ts` —— 为它注册的每个能力声明一个环境模块:

```ts
// host-modules.d.ts(宿主从其能力描述符生成)
declare module 'host:store' {
  export function getText(key: string): Promise<string | null>
  export function putText(key: string, value: string): Promise<void>
}
declare module 'host:net' {
  export function fetch(url: string, init?: RequestInit): Promise<Response>
}
```

宿主可以从自己的 rpc / 订阅描述符生成此文件;rill 只固定**文件放在哪**与**编译器如何找到它**(见下),
不规定宿主如何生成。

## 约定:放在哪、如何被采信

1. 把宿主提供的声明文件放在 **guest 工程根**,命名 `host-modules.d.ts`。
2. 让 TypeScript 采信它,以下**任一**即可(等价,按你的 `tsconfig` 选):
   - 它落入工程的 `include` 通配(根级 `*.d.ts` 默认如此),或
   - 若你的 `types` 数组有收窄,把它加进 `compilerOptions.types`,或
   - 在入口文件写 `/// <reference path="./host-modules.d.ts" />`。

因为是**环境**声明,无需在运行时 import 该文件 —— 它出现在编译中,`import ... from 'host:store'`
就能通过类型检查。

## 与 `rill/guest` 的稳定耦合

生成的 `host-modules.d.ts` 可能引用 rill 自己的 guest 类型,例如:

```ts
import type { RillKeyEvent } from 'rill/guest'
```

rill 保持 **`rill/guest` 类型出口稳定**,好让宿主生成的声明可以依赖它而不被破坏。把 `rill/guest`
视为 `host:*` 声明所引用的共享 guest 类型的唯一稳定来源。

## 完成标准

一个一方 guest 应用,删掉 `host:*` import 上方的 `@ts-expect-error` 注释后,只在工程根加入宿主的
`host-modules.d.ts`、不改任何构建配置,`tsc --noEmit` 干净通过。
