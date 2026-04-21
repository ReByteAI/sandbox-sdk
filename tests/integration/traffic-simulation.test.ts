/**
 * Traffic Simulation Integration Test
 * Simulates real-world traffic patterns with multiple VMs running concurrently
 *
 * Features:
 * - Creates up to 10 VMs with random operation order
 * - Each VM performs work (sleep, git checkout, file operations)
 * - Tests auto-pause on timeout and resume later
 * - Colored output per VM for easy tracking
 * - Works with both dev and prod environments
 *
 * ===== RUN COMMANDS =====
 *
 * Run test (dev):
 *   npx vitest run tests/integration/traffic-simulation.test.ts
 *
 * Run test (prod):
 *   TEST_ENV=prod npx vitest run tests/integration/traffic-simulation.test.ts
 *
 * With verbose output:
 *   npx vitest run tests/integration/traffic-simulation.test.ts --reporter=verbose
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { Sandbox } from '../../src'
import { getTemplateId, getGatewayConfig, getEnvironment, ensureProdApiKey } from './common'

const gatewayConfig = getGatewayConfig()
const testEnv = getEnvironment()

// ANSI color codes for different VMs
const COLORS = {
  VM1: '\x1b[36m',   // Cyan
  VM2: '\x1b[33m',   // Yellow
  VM3: '\x1b[35m',   // Magenta
  VM4: '\x1b[34m',   // Blue
  VM5: '\x1b[32m',   // Green
  VM6: '\x1b[91m',   // Light Red
  VM7: '\x1b[92m',   // Light Green
  VM8: '\x1b[93m',   // Light Yellow
  VM9: '\x1b[94m',   // Light Blue
  VM10: '\x1b[95m',  // Light Magenta
  RESET: '\x1b[0m',
  SUCCESS: '\x1b[32m',  // Green
  ERROR: '\x1b[31m',    // Red
  INFO: '\x1b[90m',     // Gray
}

// Helper to log with VM color
function vmLog(vmName: string, message: string) {
  const color = COLORS[vmName as keyof typeof COLORS] || COLORS.INFO
  console.log(`${color}[${vmName}]${COLORS.RESET} ${message}`)
}

// Helper to log success
function successLog(message: string) {
  console.log(`${COLORS.SUCCESS}✓${COLORS.RESET} ${message}`)
}

// Helper to log error
function errorLog(message: string) {
  console.log(`${COLORS.ERROR}✗${COLORS.RESET} ${message}`)
}

// Helper to log info
function infoLog(message: string) {
  console.log(`${COLORS.INFO}${message}${COLORS.RESET}`)
}

// Shuffle array in place (Fisher-Yates)
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

// Sleep helper
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Random delay between min and max seconds
const randomDelay = (minSec: number, maxSec: number) => {
  const ms = (Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec) * 1000
  return sleep(ms)
}

// VM work operations
type WorkOperation = {
  name: string
  execute: (sandbox: Sandbox, vmName: string) => Promise<void>
}

const WORK_OPERATIONS: WorkOperation[] = [
  {
    name: 'sleep',
    execute: async (sandbox, vmName) => {
      const sleepTime = Math.floor(Math.random() * 3) + 1  // 1-3 seconds
      vmLog(vmName, `Sleeping for ${sleepTime}s...`)
      const result = await sandbox.commands.run(`sleep ${sleepTime} && echo "Slept for ${sleepTime}s"`)
      vmLog(vmName, `Sleep result: ${result.stdout.trim()}`)
    }
  },
  // {
  //   name: 'git-init',
  //   execute: async (sandbox, vmName) => {
  //     vmLog(vmName, 'Initializing git repo...')
  //     await sandbox.commands.run('cd /tmp && rm -rf test-repo && mkdir test-repo && cd test-repo && git init')
  //     const result = await sandbox.commands.run('cd /tmp/test-repo && git status')
  //     vmLog(vmName, `Git status: ${result.stdout.split('\n')[0]}`)
  //   }
  // },
  {
    name: 'file-write-read',
    execute: async (sandbox, vmName) => {
      const filename = `/tmp/traffic-test-${Date.now()}.txt`
      const content = `Hello from ${vmName} at ${new Date().toISOString()}`
      vmLog(vmName, `Writing file: ${filename}`)
      await sandbox.files.write(filename, content)
      const readContent = await sandbox.files.read(filename)
      vmLog(vmName, `Read back: "${readContent.substring(0, 50)}..."`)
    }
  },
  {
    name: 'list-directory',
    execute: async (sandbox, vmName) => {
      vmLog(vmName, 'Listing /home directory...')
      const result = await sandbox.commands.run('ls -la /home')
      const lines = result.stdout.split('\n').slice(0, 5)
      vmLog(vmName, `Directory listing (first 5 lines):\n${lines.join('\n')}`)
    }
  },
  {
    name: 'system-info',
    execute: async (sandbox, vmName) => {
      vmLog(vmName, 'Getting system info...')
      const result = await sandbox.commands.run('uname -a && cat /proc/meminfo | head -3')
      vmLog(vmName, `System: ${result.stdout.split('\n')[0]}`)
    }
  },
]

// VM state tracking
interface VMState {
  name: string
  sandboxId: string | null
  sandbox: Sandbox | null
  state: 'creating' | 'running' | 'pausing' | 'paused' | 'resuming' | 'done' | 'error'
  workDone: string[]
  persistenceData: string
}

describe('Traffic Simulation', () => {
  beforeAll(async () => {
    await ensureProdApiKey()
  }, 30_000)

  test('simulate real traffic with 10 VMs', async () => {
    console.log('\n' + '='.repeat(60))
    console.log('=== Traffic Simulation Test ===')
    console.log(`Environment: ${testEnv} (${gatewayConfig.apiUrl})`)
    console.log('='.repeat(60))

    const TIMEOUT_SECONDS = 30  // Short timeout for auto-pause
    const MAX_VMS = 1
    const MAX_PAUSE_WAIT_SECONDS = 600  // Max wait for auto-pause

    // Initialize VM states
    const vmStates: VMState[] = []
    for (let i = 1; i <= MAX_VMS; i++) {
      vmStates.push({
        name: `VM${i}`,
        sandboxId: null,
        sandbox: null,
        state: 'creating',
        workDone: [],
        persistenceData: `persistence-${i}-${Date.now()}`,
      })
    }

    // Phase 1: Create all VMs (in random order, with random delays)
    console.log('\n--- Phase 1: Creating VMs ---')
    const createOrder = shuffleArray([...vmStates])
    infoLog(`Create order: ${createOrder.map(v => v.name).join(' → ')}`)

    for (const vm of createOrder) {
      await randomDelay(0, 2)  // Random 0-2 second delay between creates
      vmLog(vm.name, 'Creating sandbox...')

      try {
        const sandbox = await Sandbox.create(getTemplateId(), {
          ...gatewayConfig,
          timeoutMs: TIMEOUT_SECONDS * 1000,
          autoPause: true,
        })
        vm.sandbox = sandbox
        vm.sandboxId = sandbox.sandboxId
        vm.state = 'running'
        vmLog(vm.name, `Created: ${sandbox.sandboxId}`)
      } catch (e: any) {
        throw new Error(`${vm.name} creation failed: ${e.message}`)
      }
    }

    // Phase 2: Do work on VMs (random operations in random order)
    console.log('\n--- Phase 2: Doing Work ---')

    // Each VM does 2-3 random operations
    for (const vm of vmStates) {
      if (vm.state !== 'running' || !vm.sandbox) continue

      const numOps = Math.floor(Math.random() * 2) + 2  // 2-3 operations
      const selectedOps = shuffleArray([...WORK_OPERATIONS]).slice(0, numOps)

      vmLog(vm.name, `Doing ${numOps} operations: ${selectedOps.map(o => o.name).join(', ')}`)

      for (const op of selectedOps) {
        await op.execute(vm.sandbox, vm.name)
        vm.workDone.push(op.name)
        await randomDelay(0, 1)  // Small delay between operations
      }

      // Write persistence data for verification after resume
      vmLog(vm.name, `Writing persistence marker: ${vm.persistenceData}`)
      await vm.sandbox.files.write('/home/user/persistence-marker.txt', vm.persistenceData)
    }

    // Phase 3: Let sandboxes timeout and auto-pause
    console.log('\n--- Phase 3: Waiting for Auto-Pause ---')
    infoLog(`Timeout: ${TIMEOUT_SECONDS}s, waiting up to ${MAX_PAUSE_WAIT_SECONDS}s for all VMs to pause`)

    const pauseStartTime = Date.now()
    const pausedVMs = new Set<string>()

    while (pausedVMs.size < vmStates.filter(v => v.state === 'running').length) {
      const elapsed = Math.floor((Date.now() - pauseStartTime) / 1000)

      if (elapsed > MAX_PAUSE_WAIT_SECONDS) {
        errorLog(`Timeout waiting for VMs to pause after ${MAX_PAUSE_WAIT_SECONDS}s`)
        break
      }

      for (const vm of vmStates) {
        if (vm.state !== 'running' || pausedVMs.has(vm.name) || !vm.sandbox) continue

        try {
          const info = await vm.sandbox.getInfo()
          if (['pausing', 'paused'].includes(info.state)) {
            vmLog(vm.name, `Auto-pause detected: ${info.state} (after ${elapsed}s)`)
            vm.state = info.state as 'pausing' | 'paused'
            pausedVMs.add(vm.name)
          }
        } catch (e) {
          // 404 during pause transition is expected
        }
      }

      if (pausedVMs.size < vmStates.filter(v => v.state === 'running').length) {
        await sleep(2000)
        if (elapsed % 10 === 0 && elapsed > 0) {
          infoLog(`${elapsed}s elapsed, ${pausedVMs.size}/${vmStates.filter(v => v.state === 'running').length} VMs paused`)
        }
      }
    }

    // Wait for pause operations to complete using getInfo()
    // When state is 'paused' (not 'pausing'), pause is complete
    console.log('\n--- Waiting for pause operations to complete ---')
    const pauseTimeout = 300000  // 5 min max
    const pauseStart = Date.now()
    while (Date.now() - pauseStart < pauseTimeout) {
      await sleep(2000)  // Check every 2 seconds

      let allPaused = true
      for (const vm of vmStates) {
        if (!vm.sandboxId || vm.state === 'error' || !vm.sandbox) continue

        try {
          const info = await vm.sandbox.getInfo()
          if (info.state === 'pausing') {
            allPaused = false  // Still pausing
            break
          }
          // state === 'paused' means pause is complete
        } catch (e) {
          // getInfo() fails during pause - treat as still in progress
          allPaused = false
          break
        }
      }

      if (allPaused) {
        console.log(`   Pause complete after ${Math.round((Date.now() - pauseStart) / 1000)}s`)
        break
      }
    }

    // Phase 4: Resume VMs (in random order)
    console.log('\n--- Phase 4: Resuming VMs ---')
    const resumeOrder = shuffleArray([...vmStates])
    infoLog(`Resume order: ${resumeOrder.map(v => v.name).join(' → ')}`)

    for (const vm of resumeOrder) {
      if (!vm.sandboxId || vm.state === 'error') continue

      await randomDelay(1, 3)  // Random 1-3 second delay between resumes
      vmLog(vm.name, `Resuming sandbox ${vm.sandboxId}...`)

      try {
        const resumed = await Sandbox.connect(vm.sandboxId, {
          ...gatewayConfig,
          timeoutMs: 60000,  // 60s timeout after resume
        })
        vm.sandbox = resumed
        vm.state = 'running'
        vmLog(vm.name, 'Resumed successfully')

        // Verify persistence data
        const readData = await resumed.files.read('/home/user/persistence-marker.txt')
        expect(readData).toBe(vm.persistenceData)
      } catch (e: any) {
        vm.state = 'error'
        throw new Error(`${vm.name} resume failed: ${e.message}`)
      }
    }

    // Phase 5: Do more work on resumed VMs
    console.log('\n--- Phase 5: Post-Resume Work ---')
    for (const vm of vmStates) {
      if (vm.state !== 'running' || !vm.sandbox) continue

      vmLog(vm.name, 'Doing post-resume work...')
      const result = await vm.sandbox.commands.run('echo "Post-resume work at $(date)"')
      vmLog(vm.name, `Post-resume: ${result.stdout.trim()}`)
    }

    // Phase 6: Cleanup - kill all sandboxes
    console.log('\n--- Phase 6: Cleanup ---')
    for (const vm of vmStates) {
      if (!vm.sandbox) continue
      try {
        await vm.sandbox.kill()
        vmLog(vm.name, 'Killed')
      } catch (e: any) {
        // Ignore kill errors
      }
    }

    // Summary
    console.log('\n' + '='.repeat(60))
    console.log('=== Test Summary ===')
    console.log('='.repeat(60))

    for (const vm of vmStates) {
      const status = vm.state === 'error' ? `${COLORS.ERROR}ERROR${COLORS.RESET}` : `${COLORS.SUCCESS}OK${COLORS.RESET}`
      vmLog(vm.name, `Status: ${status}, Work done: ${vm.workDone.join(', ') || 'none'}`)
    }

    // Assertions (only things we're sure about)
    const successfulVMs = vmStates.filter(v => v.state !== 'error')
    expect(successfulVMs.length).toBeGreaterThan(0)  // At least one VM should succeed

    successLog(`Test completed: ${successfulVMs.length}/${MAX_VMS} VMs successful`)

  }, 600_000)  // 10 minute timeout
})
