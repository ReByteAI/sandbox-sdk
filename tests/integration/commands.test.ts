/**
 * Commands Integration Tests
 *
 * Tests command execution via Connect RPC:
 * - Run command (echo, whoami, pwd, env vars)
 * - Streaming output callbacks
 * - List processes
 * - Background processes
 *
 * Run:
 *   npx vitest run tests/integration/commands.test.ts
 *
 * With large template (4GB):
 *   TEST_TEMPLATE=large npx vitest run tests/integration/commands.test.ts
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { Sandbox } from '../../src'
import {
  getTemplateId,
  getGatewayConfig,
  printTestHeader,
  ensureProdApiKey,
} from './common'

const gatewayConfig = getGatewayConfig()
const TEMPLATE_ID = getTemplateId()

describe('Commands', () => {
  beforeAll(async () => {
    await ensureProdApiKey()
  }, 30_000)

  test('run command via Connect RPC', async () => {
    printTestHeader('Run Command Test')

    // 1. Create sandbox
    console.log('\n1. Creating sandbox...')
    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`   Sandbox created: ${sandbox.sandboxId}`)
    expect(sandbox.sandboxId).toBeDefined()

    try {
      // 2. Run echo command
      console.log('\n2. Running: echo "hello world"')
      const echoResult = await sandbox.commands.run('echo "hello world"', {
        timeoutMs: 30_000,
      })
      console.log(`   Exit code: ${echoResult.exitCode}`)
      console.log(`   Stdout: ${echoResult.stdout.trim()}`)
      expect(echoResult.exitCode).toBe(0)
      expect(echoResult.stdout).toContain('hello world')

      // 3. Run whoami command
      console.log('\n3. Running: whoami')
      const whoamiResult = await sandbox.commands.run('whoami', {
        timeoutMs: 30_000,
      })
      console.log(`   Exit code: ${whoamiResult.exitCode}`)
      console.log(`   Stdout: ${whoamiResult.stdout.trim()}`)
      expect(whoamiResult.exitCode).toBe(0)
      expect(whoamiResult.stdout.trim()).toBeTruthy()

      // 4. Run pwd command with cwd option
      console.log('\n4. Running: pwd (in /tmp)')
      const pwdResult = await sandbox.commands.run('pwd', {
        cwd: '/tmp',
        timeoutMs: 30_000,
      })
      console.log(`   Exit code: ${pwdResult.exitCode}`)
      console.log(`   Stdout: ${pwdResult.stdout.trim()}`)
      expect(pwdResult.exitCode).toBe(0)
      expect(pwdResult.stdout.trim()).toBe('/tmp')

      // 5. Run command with env vars
      console.log('\n5. Running: echo $MY_VAR (with env)')
      const envResult = await sandbox.commands.run('echo $MY_VAR', {
        envs: { MY_VAR: 'test-value-123' },
        timeoutMs: 30_000,
      })
      console.log(`   Exit code: ${envResult.exitCode}`)
      console.log(`   Stdout: ${envResult.stdout.trim()}`)
      expect(envResult.exitCode).toBe(0)
      expect(envResult.stdout).toContain('test-value-123')

      // 6. List processes
      console.log('\n6. Listing processes via Connect RPC...')
      const processes = await sandbox.commands.list()
      console.log(`   Found ${processes.length} processes`)
      expect(processes.length).toBeGreaterThanOrEqual(0)

      console.log('\n=== Test Passed ===')
    } finally {
      console.log('\n7. Killing sandbox...')
      await sandbox.kill()
      console.log('   Sandbox killed successfully')
    }
  }, 120_000)

  test('run command with streaming output callbacks', async () => {
    printTestHeader('Streaming Output Test')

    // 1. Create sandbox
    console.log('\n1. Creating sandbox...')
    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`   Sandbox created: ${sandbox.sandboxId}`)
    expect(sandbox.sandboxId).toBeDefined()

    try {
      // 2. Run command with streaming callbacks
      console.log('\n2. Running command with streaming callbacks...')
      const stdoutChunks: string[] = []
      const stderrChunks: string[] = []

      const handle = await sandbox.commands.run(
        'for i in 1 2 3; do echo "line $i"; sleep 0.1; done',
        {
          background: true,
          timeoutMs: 30_000,
          onStdout: (data) => {
            console.log(`   [STDOUT chunk]: ${JSON.stringify(data)}`)
            stdoutChunks.push(data)
          },
          onStderr: (data) => {
            console.log(`   [STDERR chunk]: ${JSON.stringify(data)}`)
            stderrChunks.push(data)
          },
        }
      )

      console.log(`   Command started with PID: ${handle.pid}`)
      expect(handle.pid).toBeGreaterThan(0)

      // 3. Wait for command to complete
      console.log('\n3. Waiting for command to complete...')
      const result = await handle.wait()

      console.log(`   Exit code: ${result.exitCode}`)
      console.log(`   Final stdout: ${JSON.stringify(result.stdout)}`)
      console.log(`   Stdout chunks received: ${stdoutChunks.length}`)
      console.log(`   Stderr chunks received: ${stderrChunks.length}`)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('line 1')
      expect(result.stdout).toContain('line 2')
      expect(result.stdout).toContain('line 3')
      expect(stdoutChunks.length).toBeGreaterThan(0)
      expect(stdoutChunks.join('')).toBe(result.stdout)

      // 4. Test stderr streaming
      console.log('\n4. Testing stderr streaming...')
      const stderrTestChunks: string[] = []

      const stderrHandle = await sandbox.commands.run(
        'echo "error message" >&2',
        {
          background: true,
          timeoutMs: 30_000,
          onStderr: (data) => {
            console.log(`   [STDERR chunk]: ${JSON.stringify(data)}`)
            stderrTestChunks.push(data)
          },
        }
      )

      const stderrResult = await stderrHandle.wait()
      console.log(`   Exit code: ${stderrResult.exitCode}`)
      console.log(`   Stderr: ${JSON.stringify(stderrResult.stderr)}`)

      expect(stderrResult.exitCode).toBe(0)
      expect(stderrResult.stderr).toContain('error message')
      expect(stderrTestChunks.length).toBeGreaterThan(0)

      console.log('\n=== Test Passed ===')
    } finally {
      console.log('\n5. Killing sandbox...')
      await sandbox.kill()
      console.log('   Sandbox killed successfully')
    }
  }, 120_000)
})
