/**
 * Advanced Integration Tests
 *
 * Tests edge cases and bug reproductions:
 * - ISSUE1: Pause without commands before pause
 * - ISSUE2: Background process breaks Connect RPC
 * - ISSUE2-SIMPLE: Background process blocks commands
 * - ISSUE2-PTY: PTY while streaming
 * - Dual-create prevention
 * - Dual-resume prevention
 * - Dual-pause prevention (transition guard pattern)
 * - Resume during pause (409 error)
 *
 * Run:
 *   npx vitest run tests/integration/advanced.test.ts
 *
 * With large template (4GB):
 *   TEST_TEMPLATE=large npx vitest run tests/integration/advanced.test.ts
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

describe('Advanced Edge Cases', () => {
  beforeAll(async () => {
    await ensureProdApiKey()
  }, 30_000)

  // ISSUE1: Pause without running any commands first
  test('ISSUE1: pause and resume - no commands before pause', async () => {
    printTestHeader('ISSUE1: No Commands Before Pause')

    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    try {
      // Pause immediately - no commands before pause
      console.log('Pausing immediately (no commands before pause)...')
      await sandbox.pause()
      console.log('Paused')

      // Resume
      console.log('Resuming...')
      const resumed = await Sandbox.connect(sandbox.sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
      console.log('Resumed')

      // Try to run a command
      console.log('Running command after resume...')
      const result = await resumed.commands.run('echo hello', { timeoutMs: 30_000 })
      console.log(`Output: ${result.stdout.trim()}`)
      expect(result.exitCode).toBe(0)

      await resumed.kill()
    } catch (error) {
      await Promise.allSettled([sandbox.kill()])
      throw error
    }
  }, 120_000)

  // ISSUE2: Background processes cause Connect RPC to hang after resume
  test('ISSUE2: pause and resume - background process breaks Connect RPC', async () => {
    printTestHeader('ISSUE2: Background Process Breaks RPC')

    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    try {
      // Run command before pause (avoids ISSUE1)
      console.log('Running command before pause...')
      await sandbox.commands.run('echo "before pause"', { timeoutMs: 30_000 })

      // Start background process - THIS IS THE KEY
      console.log('Starting background process (sleep infinity)...')
      const bg = await sandbox.commands.run('sleep infinity', { background: true })
      console.log(`Background process PID: ${bg.pid}`)

      // Wait a moment for the stream to be established
      await new Promise(resolve => setTimeout(resolve, 1000))

      // Pause
      console.log('\nPausing...')
      await sandbox.pause()
      console.log('Paused')

      // Resume
      console.log('Resuming...')
      const resumed = await Sandbox.connect(sandbox.sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
      console.log('Resumed')

      // Try to run a command - THIS HANGS if bug exists
      console.log('Running command after resume (this hangs with bg process if bug exists)...')
      const result = await resumed.commands.run('echo hello', { timeoutMs: 30_000 })
      console.log(`Output: ${result.stdout.trim()}`)
      expect(result.exitCode).toBe(0)

      await resumed.kill()
    } catch (error) {
      await Promise.allSettled([sandbox.kill()])
      throw error
    }
  }, 180_000)

  // ISSUE2-SIMPLE: Verify background processes don't block subsequent requests
  test('ISSUE2-SIMPLE: background process blocks subsequent commands (no pause)', async () => {
    printTestHeader('ISSUE2-SIMPLE: Background Process Test')

    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 60_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    try {
      // Step 1: Run a simple command - should work
      console.log('\n1. Running first command (echo hello)...')
      const result1 = await sandbox.commands.run('echo hello', { timeoutMs: 10_000 })
      console.log(`   Output: ${result1.stdout.trim()}`)
      expect(result1.exitCode).toBe(0)
      console.log('   First command succeeded')

      // Step 2: Start background process
      console.log('\n2. Starting background process (sleep infinity)...')
      const bg = await sandbox.commands.run('sleep infinity', { background: true })
      console.log(`   Background process PID: ${bg.pid}`)
      console.log('   Background process started')

      // Step 3: Wait a moment for the stream to be established
      console.log('\n3. Waiting 2 seconds for stream to establish...')
      await new Promise(resolve => setTimeout(resolve, 2000))

      // Step 4: Try to run another command
      console.log('\n4. Running second command (echo world) - THIS WILL TIMEOUT IF BUG EXISTS...')
      try {
        const result2 = await sandbox.commands.run('echo world', { timeoutMs: 10_000 })
        console.log(`   Output: ${result2.stdout.trim()}`)
        expect(result2.exitCode).toBe(0)
        console.log('   Second command succeeded - BUG IS FIXED!')
      } catch (e) {
        console.log(`   Second command FAILED: ${e}`)
        console.log('   This confirms the bug: background process blocks subsequent requests')
        throw e
      }

      await sandbox.kill()
    } catch (error) {
      await Promise.allSettled([sandbox.kill()])
      throw error
    }
  }, 120_000)

  // ISSUE2-PTY: Test if PTY works when streaming command is active
  test('ISSUE2-PTY: can PTY work while background process is streaming?', async () => {
    printTestHeader('ISSUE2-PTY: PTY While Streaming')

    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 60_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    try {
      // Step 1: Verify commands work initially
      console.log('\n1. Running initial command...')
      const result1 = await sandbox.commands.run('echo hello', { timeoutMs: 10_000 })
      console.log(`   Output: ${result1.stdout.trim()}`)
      expect(result1.exitCode).toBe(0)

      // Step 2: Start background process (creates streaming gRPC)
      console.log('\n2. Starting background process (sleep infinity)...')
      const bg = await sandbox.commands.run('sleep infinity', { background: true })
      console.log(`   Background PID: ${bg.pid}`)

      // Wait for stream to establish
      await new Promise(resolve => setTimeout(resolve, 2000))

      // Step 3: Try PTY (different gRPC service)
      console.log('\n3. Trying PTY while background is streaming...')
      const ptyOutput: string[] = []

      try {
        const pty = await sandbox.pty.create({
          cols: 80,
          rows: 24,
          timeoutMs: 10_000,
          onData: (data) => {
            ptyOutput.push(new TextDecoder().decode(data))
          },
        })
        console.log(`   PTY created with PID: ${pty.pid}`)

        // Send command via PTY
        await sandbox.pty.sendInput(pty.pid, new TextEncoder().encode('echo PTY_WORKS\n'))
        await new Promise(resolve => setTimeout(resolve, 1000))

        const output = ptyOutput.join('')
        console.log(`   PTY output: ${output.length} chars`)
        console.log(`   Contains PTY_WORKS: ${output.includes('PTY_WORKS')}`)

        await sandbox.pty.kill(pty.pid)

        if (output.includes('PTY_WORKS')) {
          console.log('   PTY works while streaming!')
        } else {
          console.log('   PTY created but no output')
        }
      } catch (e) {
        console.log(`   PTY failed: ${e}`)
        console.log('   PTY is also blocked by streaming!')
      }

      // Step 4: Try REST API (file operations - NOT gRPC!)
      console.log('\n4. Trying REST API (files.write/read)...')
      try {
        await sandbox.files.write('/tmp/test-rest.txt', 'REST_WORKS')
        const content = await sandbox.files.read('/tmp/test-rest.txt')
        console.log(`   File content: ${content}`)
        if (content === 'REST_WORKS') {
          console.log('   REST API works while gRPC streaming!')
        }
      } catch (e) {
        console.log(`   REST API also blocked: ${e}`)
      }

      // Step 5: Try another commands.run (expected to fail if bug exists)
      console.log('\n5. Trying commands.run (expected to timeout if bug exists)...')
      try {
        const result2 = await sandbox.commands.run('echo world', { timeoutMs: 5_000 })
        console.log(`   Output: ${result2.stdout.trim()}`)
        console.log('   commands.run works - BUG IS FIXED!')
      } catch (e) {
        console.log(`   commands.run blocked: ${e}`)
      }

      await sandbox.kill()
    } catch (error) {
      await Promise.allSettled([sandbox.kill()])
      throw error
    }
  }, 60_000)

  // Test dual-create prevention
  test('dual-create prevention: same sandbox ID at same time', async () => {
    printTestHeader('Dual-Create Prevention Test')
    const sandboxId = `dual-create-test-${Date.now()}`
    console.log(`Using sandbox ID: ${sandboxId}`)

    // Start both creates simultaneously
    console.log('\n1. Starting two creates with same ID simultaneously...')
    const createPromise1 = Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      sandboxId,
      timeoutMs: 60_000,
    }).then(s => ({ success: true, sandbox: s, error: null }))
      .catch(e => ({ success: false, sandbox: null, error: e }))

    const createPromise2 = Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      sandboxId,
      timeoutMs: 60_000,
    }).then(s => ({ success: true, sandbox: s, error: null }))
      .catch(e => ({ success: false, sandbox: null, error: e }))

    const [result1, result2] = await Promise.all([createPromise1, createPromise2])

    console.log(`   Result 1: ${result1.success ? 'SUCCESS' : 'FAILED'} - ${result1.error?.message || 'ok'}`)
    console.log(`   Result 2: ${result2.success ? 'SUCCESS' : 'FAILED'} - ${result2.error?.message || 'ok'}`)

    // Exactly one should succeed, one should fail
    const successes = [result1, result2].filter(r => r.success)
    const failures = [result1, result2].filter(r => !r.success)

    console.log(`\n2. Verifying results...`)
    console.log(`   Successes: ${successes.length}`)
    console.log(`   Failures: ${failures.length}`)

    expect(successes.length).toBe(1)
    expect(failures.length).toBe(1)

    const failedResult = failures[0]
    console.log(`   Failure reason: ${failedResult.error?.message}`)

    // Cleanup the successful sandbox
    const successfulSandbox = successes[0].sandbox
    if (successfulSandbox) {
      console.log('\n3. Cleaning up successful sandbox...')
      await successfulSandbox.kill()
      console.log('   Sandbox killed')
    }

    console.log('\n=== Test Passed ===')
  }, 120_000)

  // Test dual-resume prevention
  test('dual-resume prevention: same paused sandbox resumed at same time', async () => {
    printTestHeader('Dual-Resume Prevention Test')

    // 1. Create sandbox
    console.log('\n1. Creating sandbox...')
    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`   Sandbox created: ${sandbox.sandboxId}`)

    // 2. Pause the sandbox
    console.log('\n2. Pausing sandbox...')
    await sandbox.pause()
    console.log('   Sandbox paused')

    // Wait a moment for pause to complete
    await new Promise(resolve => setTimeout(resolve, 1000))

    // 3. Concurrently resume the sandbox
    console.log('\n3. Starting two resume requests simultaneously...')
    const resumePromise1 = Sandbox.connect(sandbox.sandboxId, {
      ...gatewayConfig,
      timeoutMs: 60_000,
    }).then(s => ({ success: true, sandbox: s, error: null }))
      .catch(e => ({ success: false, sandbox: null, error: e }))

    const resumePromise2 = Sandbox.connect(sandbox.sandboxId, {
      ...gatewayConfig,
      timeoutMs: 60_000,
    }).then(s => ({ success: true, sandbox: s, error: null }))
      .catch(e => ({ success: false, sandbox: null, error: e }))

    const [result1, result2] = await Promise.all([resumePromise1, resumePromise2])

    console.log(`   Result 1: ${result1.success ? 'SUCCESS' : 'FAILED'} - ${result1.error?.message || 'ok'}`)
    console.log(`   Result 2: ${result2.success ? 'SUCCESS' : 'FAILED'} - ${result2.error?.message || 'ok'}`)

    // Exactly one should succeed, one should fail
    const successes = [result1, result2].filter(r => r.success)
    const failures = [result1, result2].filter(r => !r.success)

    console.log(`\n4. Verifying results...`)
    console.log(`   Successes: ${successes.length}`)
    console.log(`   Failures: ${failures.length}`)

    expect(successes.length).toBe(1)
    expect(failures.length).toBe(1)

    const failedResult = failures[0]
    console.log(`   Failure reason: ${failedResult.error?.message}`)

    // Cleanup the successful sandbox
    const successfulSandbox = successes[0].sandbox
    if (successfulSandbox) {
      console.log('\n5. Cleaning up successful sandbox...')
      await successfulSandbox.kill()
      console.log('   Sandbox killed')
    }

    console.log('\n=== Test Passed ===')
  }, 180_000)

  // Test dual-pause prevention: two pause requests at the same time
  test('dual-pause prevention: same sandbox paused at same time', async () => {
    printTestHeader('Dual-Pause Prevention Test')

    // 1. Create sandbox
    console.log('\n1. Creating sandbox...')
    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`   Sandbox created: ${sandbox.sandboxId}`)

    try {
      // 2. Run a quick command to ensure sandbox is ready
      console.log('\n2. Verifying sandbox is running...')
      const result = await sandbox.commands.run('echo ready', { timeoutMs: 10_000 })
      expect(result.exitCode).toBe(0)
      console.log('   Sandbox ready')

      // 3. Start two pause requests simultaneously
      console.log('\n3. Starting two pause requests simultaneously...')
      const pausePromise1 = sandbox.pause()
        .then(() => ({ success: true, error: null }))
        .catch(e => ({ success: false, error: e }))

      const pausePromise2 = sandbox.pause()
        .then(() => ({ success: true, error: null }))
        .catch(e => ({ success: false, error: e }))

      const [result1, result2] = await Promise.all([pausePromise1, pausePromise2])

      console.log(`   Result 1: ${result1.success ? 'SUCCESS' : 'FAILED'} - ${result1.error?.message || 'ok'}`)
      console.log(`   Result 2: ${result2.success ? 'SUCCESS' : 'FAILED'} - ${result2.error?.message || 'ok'}`)

      // Both should succeed (second waits for first and returns "already done")
      console.log('\n4. Verifying results...')
      console.log('   Expected: Both succeed (second waits for first)')
      expect(result1.success).toBe(true)
      expect(result2.success).toBe(true)

      // 5. Verify sandbox is paused
      console.log('\n5. Verifying sandbox is paused...')
      const info = await sandbox.getInfo()
      console.log(`   State: ${info.state}`)
      expect(info.state).toBe('paused')

      console.log('\n=== Test Passed ===')
    } catch (error) {
      await Promise.allSettled([sandbox.kill()])
      throw error
    }
  }, 180_000)

  // Test resume during pause: returns 409
  test('resume during pause: returns 409', async () => {
    printTestHeader('Resume During Pause Test')

    // 1. Create sandbox
    console.log('\n1. Creating sandbox...')
    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    const sandboxId = sandbox.sandboxId
    console.log(`   Sandbox created: ${sandboxId}`)

    try {
      // 2. Run a quick command
      console.log('\n2. Verifying sandbox is running...')
      const result = await sandbox.commands.run('echo ready', { timeoutMs: 10_000 })
      expect(result.exitCode).toBe(0)
      console.log('   Sandbox ready')

      // 3. Start pause (don't await)
      console.log('\n3. Starting pause (not awaiting)...')
      const pausePromise = sandbox.pause()
      console.log('   Pause initiated')

      // 4. Wait briefly for state to change to Pausing
      await new Promise(resolve => setTimeout(resolve, 100))

      // 5. Try to resume while pausing - should get 409
      console.log('\n4. Trying to resume while pausing (expect 409)...')
      let resumeError: Error | null = null
      try {
        await Sandbox.connect(sandboxId, {
          ...gatewayConfig,
          timeoutMs: 5_000,
        })
        console.log('   Resume unexpectedly succeeded')
      } catch (e: any) {
        resumeError = e
        console.log(`   Got error: ${e.message}`)
      }

      // 6. Verify we got 409 error
      console.log('\n5. Verifying 409 error...')
      expect(resumeError).not.toBeNull()
      const errorMsg = resumeError?.message || ''
      const is409 = errorMsg.includes('409') || errorMsg.includes('pausing')
      console.log(`   Is 409/pausing error: ${is409}`)
      expect(is409).toBe(true)

      // 7. Wait for pause to complete
      console.log('\n6. Waiting for pause to complete...')
      await pausePromise
      console.log('   Pause completed')

      // 8. Now resume should work
      console.log('\n7. Resuming after pause completes (should succeed)...')
      const resumed = await Sandbox.connect(sandboxId, {
        ...gatewayConfig,
        timeoutMs: 60_000,
      })
      console.log(`   Resumed: ${resumed.sandboxId}`)

      // 9. Cleanup
      await resumed.kill()
      console.log('   Sandbox killed')

      console.log('\n=== Test Passed ===')
    } catch (error) {
      await Promise.allSettled([sandbox.kill()])
      throw error
    }
  }, 180_000)
})
