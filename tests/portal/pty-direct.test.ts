/**
 * Direct PTY Test - Tests PTY against portal running on host
 *
 * Run:
 *   PORTAL_URL=http://localhost:49985 DIRECT_PORTAL_TEST=1 npx vitest run tests/portal/pty-direct.test.ts
 */

import { describe, test, expect } from 'vitest'
import { createClient } from '@connectrpc/connect'
import { createGrpcWebTransport } from '@connectrpc/connect-web'
import { Process as ProcessService } from '../../src/envd/process/process_pb'

const PORTAL_URL = process.env.PORTAL_URL || 'http://localhost:49985'
const isDirectTest = process.env.DIRECT_PORTAL_TEST === '1'

// Match SDK exactly
const KEEPALIVE_PING_HEADER = 'Keepalive-Ping-Interval'
const KEEPALIVE_PING_INTERVAL_SEC = 50

describe.skipIf(!isDirectTest)('Direct PTY Test', () => {
  test('PTY start should return start event immediately (matching SDK)', async () => {
    console.log(`Testing PTY on ${PORTAL_URL}`)

    const transport = createGrpcWebTransport({
      baseUrl: PORTAL_URL,
      useBinaryFormat: true,
    })

    const client = createClient(ProcessService, transport)

    console.log('Calling Start with PTY config (matching SDK exactly)...')
    const startTime = Date.now()

    // Match SDK pty.ts lines 100-122 exactly
    const events = client.start({
      process: {
        cmd: '/bin/bash',
        args: ['-i', '-l'],
        envs: { TERM: 'xterm-256color' },
        cwd: undefined, // SDK sends this
      },
      pty: {
        size: { cols: 80, rows: 24 },
      },
    }, {
      headers: {
        [KEEPALIVE_PING_HEADER]: KEEPALIVE_PING_INTERVAL_SEC.toString(),
        // No Authorization header (like SDK when no user specified)
      },
      timeoutMs: 60_000, // SDK default
    })

    // Get first event
    const iterator = events[Symbol.asyncIterator]()
    console.log('Waiting for first event...')

    const firstEvent = await iterator.next()
    const elapsed = Date.now() - startTime

    console.log(`First event received in ${elapsed}ms:`, JSON.stringify(firstEvent.value?.event, null, 2))

    expect(firstEvent.done).toBe(false)
    expect(firstEvent.value?.event?.event?.case).toBe('start')

    const pid = firstEvent.value?.event?.event?.value?.pid
    console.log(`PTY started with PID: ${pid}`)
    expect(pid).toBeGreaterThan(0)

    // Kill it
    console.log('Killing PTY...')
    await client.sendSignal({
      process: { selector: { case: 'pid', value: pid } },
      signal: 9, // SIGKILL
    })
    console.log('PTY killed')
  }, 120_000)
})
