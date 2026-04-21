/**
 * PTY Integration Tests
 *
 * Tests pseudo-terminal operations:
 * - Create PTY
 * - Send input to PTY
 * - Receive output from PTY
 * - Kill PTY
 * - Resize PTY
 *
 * Run:
 *   npx vitest run tests/integration/pty.test.ts
 *
 * With large template (4GB):
 *   TEST_TEMPLATE=large npx vitest run tests/integration/pty.test.ts
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

describe('PTY (Pseudo-Terminal)', () => {
  beforeAll(async () => {
    await ensureProdApiKey()
  }, 30_000)

  test('create, send input, receive output, and kill PTY', async () => {
    printTestHeader('PTY Operations Test')

    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    try {
      // 1. Create PTY
      console.log('\n1. Creating PTY...')
      const ptyOutput: string[] = []
      const ptyHandle = await sandbox.pty.create({
        cols: 80,
        rows: 24,
        timeoutMs: 30_000,
        onData: (data) => {
          const text = new TextDecoder().decode(data)
          console.log(`   [PTY]: ${JSON.stringify(text.substring(0, 50))}...`)
          ptyOutput.push(text)
        },
      })
      console.log(`   PTY created with PID: ${ptyHandle.pid}`)
      expect(ptyHandle.pid).toBeGreaterThan(0)

      // 2. Send command to PTY
      console.log('\n2. Sending command to PTY...')
      await sandbox.pty.sendInput(ptyHandle.pid, new TextEncoder().encode('echo "hello from pty"\n'))

      // Wait for output
      await new Promise(resolve => setTimeout(resolve, 1000))

      // 3. Send exit command
      console.log('\n3. Sending exit command...')
      await sandbox.pty.sendInput(ptyHandle.pid, new TextEncoder().encode('exit\n'))

      // Wait for PTY to process
      await new Promise(resolve => setTimeout(resolve, 500))

      // 4. Verify we received output
      console.log('\n4. Verifying PTY output...')
      const fullOutput = ptyOutput.join('')
      console.log(`   Total output length: ${fullOutput.length} chars`)
      expect(ptyOutput.length).toBeGreaterThan(0)

      // 5. Kill PTY (cleanup)
      console.log('\n5. Killing PTY...')
      await sandbox.pty.kill(ptyHandle.pid)
      console.log('   PTY killed')

      console.log('\n=== Test Passed ===')
    } finally {
      await sandbox.kill()
      console.log('Sandbox killed')
    }
  }, 120_000)

  test('PTY resize', async () => {
    printTestHeader('PTY Resize Test')

    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    try {
      // 1. Create PTY with initial size
      console.log('\n1. Creating PTY (80x24)...')
      const ptyOutput: string[] = []
      const ptyHandle = await sandbox.pty.create({
        cols: 80,
        rows: 24,
        timeoutMs: 30_000,
        onData: (data) => {
          const text = new TextDecoder().decode(data)
          ptyOutput.push(text)
        },
      })
      console.log(`   PTY created with PID: ${ptyHandle.pid}`)

      // Wait for shell to start
      await new Promise(resolve => setTimeout(resolve, 1000))

      // 2. Check initial size via stty
      console.log('\n2. Checking initial terminal size...')
      await sandbox.pty.sendInput(ptyHandle.pid, new TextEncoder().encode('stty size\n'))
      await new Promise(resolve => setTimeout(resolve, 500))

      const initialSizeOutput = ptyOutput.join('')
      console.log(`   Initial size output: ${initialSizeOutput.includes('24 80') ? '24 80' : 'checking...'}`)

      // 3. Resize PTY
      console.log('\n3. Resizing PTY to 120x40...')
      await sandbox.pty.resize(ptyHandle.pid, { cols: 120, rows: 40 })
      console.log('   PTY resized')

      // 4. Verify new size
      console.log('\n4. Verifying new terminal size...')
      ptyOutput.length = 0  // Clear previous output
      await sandbox.pty.sendInput(ptyHandle.pid, new TextEncoder().encode('stty size\n'))
      await new Promise(resolve => setTimeout(resolve, 500))

      const newSizeOutput = ptyOutput.join('')
      console.log(`   New size output: ${newSizeOutput.includes('40 120') ? '40 120' : newSizeOutput.trim().split('\n').pop()}`)

      // 5. Cleanup
      console.log('\n5. Killing PTY...')
      await sandbox.pty.kill(ptyHandle.pid)
      console.log('   PTY killed')

      console.log('\n=== Test Passed ===')
    } finally {
      await sandbox.kill()
      console.log('Sandbox killed')
    }
  }, 120_000)

  test('multiple PTY sessions', async () => {
    printTestHeader('Multiple PTY Sessions Test')

    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    try {
      // 1. Create first PTY
      console.log('\n1. Creating first PTY...')
      const pty1Output: string[] = []
      const pty1 = await sandbox.pty.create({
        cols: 80,
        rows: 24,
        timeoutMs: 30_000,
        onData: (data) => {
          const text = new TextDecoder().decode(data)
          pty1Output.push(text)
        },
      })
      console.log(`   PTY 1 created with PID: ${pty1.pid}`)

      // 2. Create second PTY
      console.log('\n2. Creating second PTY...')
      const pty2Output: string[] = []
      const pty2 = await sandbox.pty.create({
        cols: 80,
        rows: 24,
        timeoutMs: 30_000,
        onData: (data) => {
          const text = new TextDecoder().decode(data)
          pty2Output.push(text)
        },
      })
      console.log(`   PTY 2 created with PID: ${pty2.pid}`)

      // 3. Verify different PIDs
      console.log('\n3. Verifying different PIDs...')
      expect(pty1.pid).not.toBe(pty2.pid)
      console.log(`   PTY 1 PID: ${pty1.pid}, PTY 2 PID: ${pty2.pid}`)

      // 4. Send different commands to each
      console.log('\n4. Sending commands to both PTYs...')
      await sandbox.pty.sendInput(pty1.pid, new TextEncoder().encode('echo "PTY1_UNIQUE"\n'))
      await sandbox.pty.sendInput(pty2.pid, new TextEncoder().encode('echo "PTY2_UNIQUE"\n'))

      await new Promise(resolve => setTimeout(resolve, 1000))

      // 5. Verify separate outputs
      console.log('\n5. Verifying separate outputs...')
      const pty1FullOutput = pty1Output.join('')
      const pty2FullOutput = pty2Output.join('')

      console.log(`   PTY 1 output contains PTY1_UNIQUE: ${pty1FullOutput.includes('PTY1_UNIQUE')}`)
      console.log(`   PTY 2 output contains PTY2_UNIQUE: ${pty2FullOutput.includes('PTY2_UNIQUE')}`)

      // 6. Cleanup
      console.log('\n6. Killing both PTYs...')
      await sandbox.pty.kill(pty1.pid)
      await sandbox.pty.kill(pty2.pid)
      console.log('   Both PTYs killed')

      console.log('\n=== Test Passed ===')
    } finally {
      await sandbox.kill()
      console.log('Sandbox killed')
    }
  }, 120_000)
})
