# Integration Tests

TypeScript SDK integration tests for microsandbox.

## Prerequisites

1. Node.js >= 20
2. pnpm installed
3. Gateway running (dev or prod)
4. Templates registered in the environment

## Running Tests

From the `sdk/typescript-new/packages/js-sdk` directory.

**IMPORTANT**: Always redirect output to a log file for inspection. Tests can be long-running and produce extensive output.

```bash
# Run a specific test file (always save to log)
npx vitest run tests/integration/sandbox.test.ts 2>&1 | tee /tmp/sandbox.log

# With verbose output
npx vitest run tests/integration/sandbox.test.ts --reporter=verbose 2>&1 | tee /tmp/sandbox.log

# Inspect result
tail -100 /tmp/sandbox.log

# Run all integration tests
pnpm test:integration 2>&1 | tee /tmp/sdk-integration.log
```

## Available Tests

| Test | Description |
|------|-------------|
| `latency.test.ts` | Simple create/kill latency (~2-3s, matches Rust test) |
| `sandbox.test.ts` | Core lifecycle: create, get info, kill, parallel sandboxes |
| `commands.test.ts` | Command execution in sandboxes |
| `filesystem.test.ts` | File read/write operations |
| `network.test.ts` | Network connectivity tests |
| `pause-resume.test.ts` | Pause and resume sandbox state |
| `pty.test.ts` | PTY/terminal operations |
| `randomness.test.ts` | Random number generation tests |
| `streaming-pause.test.ts` | Streaming with pause/resume |
| `stress.test.ts` | Stress testing sandbox operations |
| `template-v2.test.ts` | Template v2 API tests |
| `traffic-simulation.test.ts` | Multi-VM concurrent traffic simulation |
| `vm-stress.test.ts` | VM-level stress tests |
| `advanced.test.ts` | Advanced SDK features |

## Configuration

| Env Variable | Values | Default | Description |
|--------------|--------|---------|-------------|
| `TEST_TEMPLATE` | `small`, `large` | `small` | Template size to use |
| `TEST_ENV` | `dev`, `prod` | `dev` | Target environment |

## Examples

```bash
# Run sandbox test, save to log
npx vitest run tests/integration/sandbox.test.ts 2>&1 | tee /tmp/sandbox.log
tail -100 /tmp/sandbox.log

# Run with large template (4GB)
TEST_TEMPLATE=large npx vitest run tests/integration/sandbox.test.ts 2>&1 | tee /tmp/sandbox.log

# Run against production
TEST_ENV=prod npx vitest run tests/integration/sandbox.test.ts 2>&1 | tee /tmp/sandbox.log

# Run traffic simulation (vital test)
npx vitest run tests/integration/traffic-simulation.test.ts 2>&1 | tee /tmp/traffic.log
tail -100 /tmp/traffic.log

# Run all integration tests with verbose output
pnpm test:integration -- --reporter=verbose 2>&1 | tee /tmp/sdk-all.log

# Run specific test by name
npx vitest run tests/integration/sandbox.test.ts -t "create, get info" 2>&1 | tee /tmp/sandbox.log
```

## Template IDs

| Size | Memory | Rootfs | Description | Template ID |
|------|--------|--------|-------------|-------------|
| small | 512MB | 1GB | debian, 1 vCPU | `7886ab23-feec-42c7-a91b-1956718664fc` |
| large | 4GB | 15GB | rebyte-sandbox-vm, 2 vCPU | `99c839c4-480a-4ec3-abcf-290dbcd4a663` |

## Environments

| Environment | API URL | Domain |
|-------------|---------|--------|
| dev | `https://dev.rebyte.app` | `dev.rebyte.app` |
| prod | `https://prod.rebyte.app` | `prod.rebyte.app` |

## Vital Tests

These tests are critical and should pass before deployment (per CLAUDE.md):

- `traffic-simulation.test.ts` - Multi-VM concurrent traffic simulation

## Test Files

- `common.ts` - Shared utilities (template config, environment setup, test helpers)
- All `*.test.ts` files - Individual test suites

## Troubleshooting

### Tests timeout
- Check if gateway is running: `curl https://dev.rebyte.app/health`
- Verify template exists in the environment
- Increase timeout: tests use 300s (5 min) by default

### API key errors (prod only)
- The test harness auto-seeds the test API key in prod
- If issues persist, check database connectivity

### Template not found
- Verify template ID exists: `msb template list`
- Template IDs differ between dev and prod environments
