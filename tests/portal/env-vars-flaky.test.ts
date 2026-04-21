/**
 * Streaming Race Condition Test - Direct Portal Test
 *
 * This test verifies that the streaming race condition fix works correctly.
 * It streams 10 lines of output with env vars to verify all data is received
 * before the end event.
 *
 * Run portal first:
 *   cd /home/homo/microsandbox
 *   cargo build -p microsandbox-portal
 *   ~/.local/bin/portal -p 49984 -d &
 *
 * Then run test:
 *   cd sdk/typescript-new/packages/js-sdk
 *   PORTAL_URL=http://localhost:49984 DIRECT_PORTAL_TEST=1 \
 *     npx vitest run tests/portal/env-vars-flaky.test.ts --reporter=verbose
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { createClient } from '@connectrpc/connect'
import { createGrpcWebTransport } from '@connectrpc/connect-web'
import { Process as ProcessService } from '../../src/envd/process/process_pb'

const PORTAL_URL = process.env.PORTAL_URL || 'http://localhost:49984'
const isDirectPortalTest = process.env.PORTAL_URL !== undefined || process.env.DIRECT_PORTAL_TEST === '1'

describe.skipIf(!isDirectPortalTest)('Streaming Race Condition Test - Direct Portal', () => {
  let processClient: ReturnType<typeof createClient<typeof ProcessService>>

  beforeAll(() => {
    console.log(`\n========================================`)
    console.log(`Streaming Race Condition Test - Direct Portal`)
    console.log(`Portal URL: ${PORTAL_URL}`)
    console.log(`========================================\n`)

    const transport = createGrpcWebTransport({
      baseUrl: PORTAL_URL,
      useBinaryFormat: true,
    })

    processClient = createClient(ProcessService, transport)
  })

  // Run streaming test multiple times to check for race conditions
  const iterations = 10

  for (let i = 1; i <= iterations; i++) {
    test(`streaming 10 lines with env vars - iteration ${i}/${iterations}`, async () => {
      console.log(`\n--- Iteration ${i}/${iterations} ---`)

      const prefix = `iter-${i}-${Date.now()}`

      // Stream 10 lines of output with env var in each line
      const events = processClient.start({
        process: {
          cmd: '/bin/bash',
          args: ['-c', 'for n in 1 2 3 4 5 6 7 8 9 10; do echo "$PREFIX line $n"; done'],
          envs: { PREFIX: prefix },
        },
        stdin: false,
      }, { timeoutMs: 30_000 })

      const stdoutChunks: string[] = []
      let exitCode: number | undefined
      let pid: number | undefined

      for await (const event of events) {
        const e = event.event?.event
        if (e?.case === 'start') {
          pid = e.value.pid
          console.log(`  PID: ${pid}`)
        } else if (e?.case === 'data') {
          if (e.value.output.case === 'stdout') {
            const chunk = new TextDecoder().decode(e.value.output.value)
            stdoutChunks.push(chunk)
            console.log(`  [CHUNK ${stdoutChunks.length}]: ${JSON.stringify(chunk)}`)
          }
        } else if (e?.case === 'end') {
          exitCode = e.value.exitCode
          console.log(`  [END] exit code: ${exitCode}`)
        }
      }

      const stdout = stdoutChunks.join('')
      const lines = stdout.trim().split('\n')

      console.log(`  Total chunks: ${stdoutChunks.length}`)
      console.log(`  Total lines: ${lines.length}`)
      console.log(`  Exit code: ${exitCode}`)

      expect(pid).toBeGreaterThan(0)
      expect(exitCode).toBe(0)
      expect(lines.length).toBe(10)

      // Verify each line has the correct prefix
      for (let n = 1; n <= 10; n++) {
        expect(lines[n - 1]).toBe(`${prefix} line ${n}`)
      }
    }, 30_000)
  }

  // Test with longer streaming output (20 lines to avoid buffer issues)
  test('streaming 20 lines rapidly', async () => {
    console.log('\n--- Streaming 20 lines rapidly ---')

    const prefix = `rapid-${Date.now()}`

    const events = processClient.start({
      process: {
        cmd: '/bin/bash',
        args: ['-c', 'for n in $(seq 1 20); do echo "$PREFIX line $n"; done'],
        envs: { PREFIX: prefix },
      },
      stdin: false,
    }, { timeoutMs: 30_000 })

    const stdoutChunks: string[] = []
    let exitCode: number | undefined

    for await (const event of events) {
      const e = event.event?.event
      if (e?.case === 'data' && e.value.output.case === 'stdout') {
        stdoutChunks.push(new TextDecoder().decode(e.value.output.value))
      } else if (e?.case === 'end') {
        exitCode = e.value.exitCode
      }
    }

    const stdout = stdoutChunks.join('')
    const lines = stdout.trim().split('\n')

    console.log(`  Total chunks: ${stdoutChunks.length}`)
    console.log(`  Total lines: ${lines.length}`)
    console.log(`  First line: ${lines[0]}`)
    console.log(`  Last line: ${lines[lines.length - 1]}`)

    expect(exitCode).toBe(0)
    expect(lines.length).toBe(20)
    expect(lines[0]).toBe(`${prefix} line 1`)
    expect(lines[19]).toBe(`${prefix} line 20`)
  }, 30_000)

  // Test streaming with delays between lines
  test('streaming with delays between lines', async () => {
    console.log('\n--- Streaming with delays ---')

    const prefix = `delayed-${Date.now()}`

    const events = processClient.start({
      process: {
        cmd: '/bin/bash',
        args: ['-c', 'for n in 1 2 3 4 5; do echo "$PREFIX line $n"; sleep 0.05; done'],
        envs: { PREFIX: prefix },
      },
      stdin: false,
    }, { timeoutMs: 30_000 })

    const stdoutChunks: string[] = []
    let exitCode: number | undefined

    for await (const event of events) {
      const e = event.event?.event
      if (e?.case === 'data' && e.value.output.case === 'stdout') {
        const chunk = new TextDecoder().decode(e.value.output.value)
        stdoutChunks.push(chunk)
        console.log(`  [CHUNK]: ${JSON.stringify(chunk)}`)
      } else if (e?.case === 'end') {
        exitCode = e.value.exitCode
      }
    }

    const stdout = stdoutChunks.join('')
    const lines = stdout.trim().split('\n')

    console.log(`  Total chunks: ${stdoutChunks.length}`)
    console.log(`  Total lines: ${lines.length}`)

    expect(exitCode).toBe(0)
    expect(lines.length).toBe(5)
    for (let n = 1; n <= 5; n++) {
      expect(lines[n - 1]).toBe(`${prefix} line ${n}`)
    }
  }, 30_000)

  // Test mixed stdout and stderr streaming
  test('mixed stdout and stderr streaming', async () => {
    console.log('\n--- Mixed stdout/stderr streaming ---')

    const events = processClient.start({
      process: {
        cmd: '/bin/bash',
        args: ['-c', 'echo "stdout 1"; echo "stderr 1" >&2; echo "stdout 2"; echo "stderr 2" >&2; echo "stdout 3"'],
      },
      stdin: false,
    }, { timeoutMs: 30_000 })

    let stdout = ''
    let stderr = ''
    let exitCode: number | undefined

    for await (const event of events) {
      const e = event.event?.event
      if (e?.case === 'data') {
        if (e.value.output.case === 'stdout') {
          const chunk = new TextDecoder().decode(e.value.output.value)
          stdout += chunk
          console.log(`  [STDOUT]: ${JSON.stringify(chunk)}`)
        } else if (e.value.output.case === 'stderr') {
          const chunk = new TextDecoder().decode(e.value.output.value)
          stderr += chunk
          console.log(`  [STDERR]: ${JSON.stringify(chunk)}`)
        }
      } else if (e?.case === 'end') {
        exitCode = e.value.exitCode
      }
    }

    console.log(`  Final stdout: ${JSON.stringify(stdout)}`)
    console.log(`  Final stderr: ${JSON.stringify(stderr)}`)

    expect(exitCode).toBe(0)
    expect(stdout).toContain('stdout 1')
    expect(stdout).toContain('stdout 2')
    expect(stdout).toContain('stdout 3')
    expect(stderr).toContain('stderr 1')
    expect(stderr).toContain('stderr 2')
  }, 30_000)
})
