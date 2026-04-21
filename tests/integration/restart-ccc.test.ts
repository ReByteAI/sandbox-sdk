/**
 * Quick test: restart CCC inside a running 4GB sandbox and check if it responds.
 */
import { describe, test, expect } from 'vitest'
import { Sandbox } from '../../src'
import { getGatewayConfig } from './common'

const gatewayConfig = getGatewayConfig()
const TEMPLATE_4GB = '28cf6050-622f-460e-8342-dac8a8b8526f'

describe('Restart CCC', () => {
  test('systemctl restart ccc on 4GB sandbox', async () => {
    console.log('Creating fresh 4GB sandbox...')
    const sb = await Sandbox.create(TEMPLATE_4GB, {
      ...gatewayConfig,
      timeoutMs: 60_000,
    })
    const SANDBOX_ID = sb.sandboxId
    console.log(`Created: ${SANDBOX_ID}`)

    console.log('=== systemctl status ccc (before) ===')
    const s1 = await sb.commands.run('systemctl status ccc 2>&1 || true', { timeoutMs: 10_000 })
    console.log(s1.stdout)

    console.log('=== journalctl -u ccc -n 20 ===')
    const j1 = await sb.commands.run('journalctl -u ccc -n 20 --no-pager 2>&1 || true', { timeoutMs: 10_000 })
    console.log(j1.stdout)

    console.log('=== Restarting CCC ===')
    const r = await sb.commands.run('sudo systemctl restart ccc', { timeoutMs: 15_000 })
    console.log('Exit:', r.exitCode)
    if (r.stderr) console.log('Stderr:', r.stderr)

    // Wait for CCC to start
    await new Promise(r => setTimeout(r, 3000))

    console.log('=== systemctl status ccc (after) ===')
    const s2 = await sb.commands.run('systemctl status ccc 2>&1 || true', { timeoutMs: 10_000 })
    console.log(s2.stdout)

    // Now test gRPC health check
    console.log('=== Testing CCC health check ===')
    const url = `https://50051-${SANDBOX_ID}.dev.rebyte.app/supervisor.v1.SupervisorService/CheckHealth`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/grpc-web+proto',
        'Accept': 'application/grpc-web+proto',
      },
      body: new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00]),
      signal: AbortSignal.timeout(5000),
    })
    console.log(`Health check: HTTP ${res.status}`)
    expect(res.status).toBe(200)
  }, 60_000)
})
