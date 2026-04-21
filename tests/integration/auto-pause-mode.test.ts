/**
 * Auto-Pause Mode Integration Test
 *
 * Tests the autoPauseMode feature:
 * - "pause" mode: full memory snapshot on timeout → fast resume
 * - "hibernate" mode: rootfs-only on timeout → cold boot resume
 * - No mode (default): sandbox killed on timeout
 *
 * Run:
 *   npx vitest run tests/integration/auto-pause-mode.test.ts
 *
 * Run specific test:
 *   npx vitest run tests/integration/auto-pause-mode.test.ts -t "pause mode"
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

// Short timeout so tests don't take forever
const SHORT_TIMEOUT_MS = 15_000 // 15s

describe('Auto-Pause Mode', () => {
  beforeAll(async () => {
    await ensureProdApiKey()
  }, 30_000)

  test('pause mode: full snapshot on timeout, fast resume', async () => {
    printTestHeader('Auto-Pause Mode: pause (full snapshot)')

    // 1. Create sandbox with autoPauseMode: "pause"
    console.log('1. Creating sandbox with autoPauseMode: "pause"...')
    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: SHORT_TIMEOUT_MS,
      autoPauseMode: 'pause',
    })
    console.log(`   Created: ${sandbox.sandboxId}`)
    expect(sandbox.sandboxId).toBeDefined()

    try {
      // 2. Write a file to verify disk persistence
      console.log('2. Writing marker file...')
      await sandbox.files.write('/home/user/pause-test.txt', 'pause-mode-test')
      const readResult = await sandbox.commands.run('cat /home/user/pause-test.txt', { timeoutMs: 10_000 })
      expect(readResult.stdout.trim()).toBe('pause-mode-test')
      console.log(`   Written and verified: ${readResult.stdout.trim()}`)

      // 3. Wait for timeout + auto-pause to complete
      console.log(`3. Waiting for timeout (${SHORT_TIMEOUT_MS / 1000}s) + auto-pause...`)
      let paused = false
      const maxWaitSeconds = (SHORT_TIMEOUT_MS / 1000) + 120 // extra buffer for pause operation

      for (let i = 1; i <= maxWaitSeconds; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        try {
          const info = await sandbox.getInfo()
          if (info.state === 'paused' || info.state === 'pausing') {
            console.log(`   Auto-pause detected after ${i}s (state: ${info.state})`)
            paused = true
            // Wait for pause to complete
            if (info.state === 'pausing') {
              for (let j = 0; j < 120; j++) {
                await new Promise(resolve => setTimeout(resolve, 1000))
                const check = await sandbox.getInfo()
                if (check.state === 'paused') break
              }
            }
            break
          }
        } catch {
          // Sandbox may not be queryable during transition
        }
        if (i % 10 === 0) console.log(`   [${i}s] Still waiting...`)
      }
      expect(paused).toBe(true)

      // 4. Resume and verify speed + file persistence
      console.log('4. Resuming sandbox...')
      const resumeStart = Date.now()
      const resumed = await Sandbox.connect(sandbox.sandboxId, {
        ...gatewayConfig,
        timeoutMs: 60_000,
      })
      const resumeMs = Date.now() - resumeStart
      console.log(`   Resumed in ${resumeMs}ms`)

      // Verify file persisted
      const afterResume = await resumed.commands.run('cat /home/user/pause-test.txt', { timeoutMs: 10_000 })
      console.log(`   File after resume: ${afterResume.stdout.trim()}`)
      expect(afterResume.stdout.trim()).toBe('pause-mode-test')

      console.log('=== PASS: pause mode works ===')
      await resumed.kill()
    } catch (error) {
      try { await sandbox.kill() } catch {}
      throw error
    }
  }, 300_000) // 5 min test timeout

  test('hibernate mode: rootfs-only on timeout, cold boot resume', async () => {
    printTestHeader('Auto-Pause Mode: hibernate (rootfs-only)')

    // 1. Create sandbox with autoPauseMode: "hibernate"
    console.log('1. Creating sandbox with autoPauseMode: "hibernate"...')
    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: SHORT_TIMEOUT_MS,
      autoPauseMode: 'hibernate',
    })
    console.log(`   Created: ${sandbox.sandboxId}`)
    expect(sandbox.sandboxId).toBeDefined()

    try {
      // 2. Verify sandbox is functional before timeout
      console.log('2. Verifying sandbox is functional...')
      const result = await sandbox.commands.run('echo alive', { timeoutMs: 10_000 })
      expect(result.stdout.trim()).toBe('alive')
      console.log(`   Sandbox functional: ${result.stdout.trim()}`)

      // 3. Wait for timeout + auto-pause
      console.log(`3. Waiting for timeout (${SHORT_TIMEOUT_MS / 1000}s) + auto-hibernate...`)
      let paused = false
      const maxWaitSeconds = (SHORT_TIMEOUT_MS / 1000) + 120

      for (let i = 1; i <= maxWaitSeconds; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        try {
          const info = await sandbox.getInfo()
          if (info.state === 'paused' || info.state === 'pausing') {
            console.log(`   Auto-hibernate detected after ${i}s (state: ${info.state})`)
            paused = true
            if (info.state === 'pausing') {
              for (let j = 0; j < 120; j++) {
                await new Promise(resolve => setTimeout(resolve, 1000))
                const check = await sandbox.getInfo()
                if (check.state === 'paused') break
              }
            }
            break
          }
        } catch {
          // Sandbox may not be queryable during transition
        }
        if (i % 10 === 0) console.log(`   [${i}s] Still waiting...`)
      }
      expect(paused).toBe(true)

      // 4. Resume (cold boot) and verify sandbox is functional
      console.log('4. Resuming sandbox (cold boot expected)...')
      const resumeStart = Date.now()
      const resumed = await Sandbox.connect(sandbox.sandboxId, {
        ...gatewayConfig,
        timeoutMs: 60_000,
      })
      const resumeMs = Date.now() - resumeStart
      console.log(`   Resumed in ${resumeMs}ms (cold boot)`)

      // Verify sandbox is functional after cold boot
      const afterResume = await resumed.commands.run('echo resumed-ok', { timeoutMs: 10_000 })
      console.log(`   After resume: ${afterResume.stdout.trim()}`)
      expect(afterResume.stdout.trim()).toBe('resumed-ok')

      console.log('=== PASS: hibernate mode works (auto-hibernate + cold boot resume) ===')
      await resumed.kill()
    } catch (error) {
      try { await sandbox.kill() } catch {}
      throw error
    }
  }, 300_000)

  test('default: sandbox auto-pauses on timeout (autoPauseMode defaults to "pause")', async () => {
    printTestHeader('Auto-Pause Mode: default (pause)')

    // 1. Create sandbox with default settings (no explicit autoPauseMode)
    console.log('1. Creating sandbox with defaults...')
    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: SHORT_TIMEOUT_MS,
    })
    console.log(`   Created: ${sandbox.sandboxId}`)
    const sandboxId = sandbox.sandboxId

    // 2. Wait for timeout + auto-pause
    console.log(`2. Waiting for timeout (${SHORT_TIMEOUT_MS / 1000}s) + auto-pause...`)
    let paused = false
    const maxWaitSeconds = (SHORT_TIMEOUT_MS / 1000) + 120

    for (let i = 1; i <= maxWaitSeconds; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      try {
        const info = await sandbox.getInfo()
        if (info.state === 'paused') {
          console.log(`   Auto-pause completed after ${i}s`)
          paused = true
          break
        }
        if (info.state === 'pausing') {
          console.log(`   Auto-pause in progress after ${i}s, waiting for completion...`)
        }
      } catch {}
      if (i % 10 === 0) console.log(`   [${i}s] Still waiting...`)
    }
    expect(paused).toBe(true)

    // 3. Connect should succeed (sandbox is paused, not killed)
    console.log('3. Connecting to paused sandbox...')
    const resumed = await Sandbox.connect(sandboxId, {
      ...gatewayConfig,
      timeoutMs: 60_000,
    })
    const result = await resumed.commands.run('echo alive', { timeoutMs: 10_000 })
    expect(result.stdout.trim()).toBe('alive')
    console.log(`   Connected and functional: ${result.stdout.trim()}`)

    console.log('=== PASS: default auto-pause works ===')
    await resumed.kill()
  }, 300_000)
})
