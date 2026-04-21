# sandbox-sdk (package: `rebyte-sandbox`)

TypeScript SDK for the Rebyte sandbox infrastructure — the `microsandbox` VM
runtime plus the lifecycle pattern that keeps a VM warm from a UI + HTTP app.

Extended from the [E2B SDK](https://github.com/e2b-dev/E2B) with Rebyte-specific
optimizations for VM lifecycle. Two headline capabilities:

- **Resume a VM** — pause a VM with a full memory + disk snapshot
  (`sandbox.pause()`), then resume it later via `Sandbox.connect(id)`. Restore
  is near-instant (~100–500ms) and running processes continue exactly where
  they left off.
- **Hibernate a VM** — rootfs-only pause (`sandbox.hibernate()`) that saves
  disk state without a memory snapshot. Snapshotting is ~40–50% faster than a
  full pause; on `connect()` the VM cold boots (~5–7s) with all disk
  modifications intact.

> Canonical source for this package. Replaces `cctools/packages/rebytevm-sdk`.


## Layout

```
src/               SDK: Sandbox.connect, filesystem, commands, errors, …
vm-lifecycle/      Lifecycle pattern:
  VmProvider.tsx     React provider (poll ensure while mounted)
  ensureVmRunning.ts Express middleware (connect with retry, attach req.sandbox)
```

## Consuming via GitHub (no npm publish needed)

```jsonc
// package.json
{
  "dependencies": {
    "rebyte-sandbox": "git+https://github.com/ReByteAI/sandbox-sdk.git#main"
  }
}
```

Pin to a commit SHA or tag for stability: `…#v0.1.0` or `…#a1b2c3d`.

## vm-lifecycle imports

Classic path imports — work regardless of `moduleResolution`:

```ts
import { VmProvider, useVm } from 'rebyte-sandbox/vm-lifecycle/VmProvider'
import { ensureVmRunning } from 'rebyte-sandbox/vm-lifecycle/ensureVmRunning'
```

Frontend peer deps the provider expects: `react >=17`, `@tanstack/react-query ^5`.
Server peer deps the middleware expects: `express ^4`.

## Building the SDK

```bash
pnpm install
pnpm build     # tsup → dist/
```

`vm-lifecycle/` ships as source `.ts/.tsx`; consumers TypeScript-compile it
directly.
