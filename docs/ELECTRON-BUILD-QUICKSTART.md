# Electron Build Quickstart

## Required

- Node 24.13.1
- Bun 1.3.14
- Git
- native compiler toolchain appropriate to your OS

## Verify and package

```bash
bun ci
bun run build
```

## Full release gate

```bash
bun ci
bun run release:zenith
```

## Development

```bash
bun start
```

## E2E package

```bash
bun run package:e2e
```

If `doctor:electron` fails, fix the reported toolchain/native dependency problem before packaging. Do not bypass the doctor or post-package verifier for release builds.
