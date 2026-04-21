/**
 * Streaming Pause/Resume Test
 *
 * Tests whether streaming servers work after VM pause/resume.
 * This helps isolate whether ISSUE2 is portal-specific or affects any streaming server.
 *
 * NOTE: Architecture is HTTP-only. External raw TCP forwarding is NOT supported.
 * The gateway and orchestrator only proxy HTTP traffic. For SSH/TCP access,
 * WebSocket tunneling would be needed (not currently implemented).
 *
 * Test Matrix:
 * | Server Type | Stream Open During Pause | Expected |
 * |-------------|--------------------------|----------|
 * | TCP (in-VM) | No                       | PASS     |
 * | gRPC (in-VM)| No                       | PASS     |
 * | Portal      | No                       | PASS     |
 * | Portal      | Yes (SDK stream)         | PASS (fixed with spawn_blocking) |
 * | HTTP stream | Yes                      | PASS     |
 *
 * Run with:
 *   REBYTE_SANDBOX_GATEWAY_TEST=1 REBYTE_SANDBOX_API_URL=http://localhost:8080 REBYTE_SANDBOX_API_KEY=test-key \
 *     pnpm exec vitest run tests/integration/streaming-pause.test.ts
 */

import { describe, test, expect } from 'vitest'
import { Sandbox } from '../../src'
import * as fs from 'fs'
import * as path from 'path'
import * as net from 'net'
import * as http from 'http'
import { getTemplateId, getGatewayConfig } from './common'

const gatewayConfig = getGatewayConfig()

const isGatewayTest = process.env.REBYTE_SANDBOX_GATEWAY_TEST === '1'

// Path to test server binaries
const FIXTURES_DIR = path.join(__dirname, '../fixtures')
const TCP_SERVER_PATH = path.join(FIXTURES_DIR, 'tcp-stream-server')
const GRPC_SERVER_PATH = path.join(FIXTURES_DIR, 'grpc-stream-server')
const HTTP_SERVER_PATH = path.join(FIXTURES_DIR, 'http-stream-server')

describe.skipIf(!isGatewayTest)('Streaming Pause/Resume Investigation', () => {

  test('TCP server - no stream during pause', async () => {
    console.log('=== TCP Server Test (no stream during pause) ===')

    const sandbox = await Sandbox.create(getTemplateId(), {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    try {
      // Upload TCP server binary
      console.log('Uploading TCP server binary...')
      const tcpBinary = fs.readFileSync(TCP_SERVER_PATH)
      await sandbox.files.write('/tmp/tcp-server', tcpBinary)
      await sandbox.commands.run('chmod +x /tmp/tcp-server')
      console.log('Binary uploaded')

      // Start TCP server using & (no SDK stream)
      console.log('Starting TCP server on port 9000...')
      await sandbox.commands.run('/tmp/tcp-server 9000 > /tmp/tcp.log 2>&1 &')
      console.log('Server started')

      // Wait for server to start
      await new Promise(r => setTimeout(r, 1000))

      // Don't connect - no stream during pause

      // Pause
      console.log('Pausing...')
      await sandbox.pause()
      console.log('Paused')

      // Resume
      console.log('Resuming...')
      const resumed = await Sandbox.connect(sandbox.sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
      console.log('Resumed')

      // Test portal works
      console.log('Testing portal...')
      const result = await resumed.commands.run('echo "portal works"', { timeoutMs: 30_000 })
      console.log(`Portal output: ${result.stdout.trim()}`)
      expect(result.exitCode).toBe(0)

      // Test TCP server still works - check process is running
      console.log('Checking TCP server process...')
      const psResult = await resumed.commands.run('pgrep -f tcp-server', { timeoutMs: 5_000 })
      console.log(`TCP server PIDs: ${psResult.stdout.trim()}`)

      console.log('=== TEST PASSED ===')
      await resumed.kill()
    } catch (error) {
      console.error('Test failed:', error)
      await sandbox.kill().catch(() => {})
      throw error
    }
  }, 120_000)

  test('TCP server - in-VM server running during pause', async () => {
    console.log('=== TCP Server Test (in-VM server running during pause) ===')

    const sandbox = await Sandbox.create(getTemplateId(), {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    try {
      // Upload TCP server binary
      console.log('Uploading TCP server binary...')
      const tcpBinary = fs.readFileSync(TCP_SERVER_PATH)
      await sandbox.files.write('/tmp/tcp-server', tcpBinary)
      await sandbox.commands.run('chmod +x /tmp/tcp-server')
      console.log('Binary uploaded')

      // Start TCP server using & (no SDK stream)
      console.log('Starting TCP server on port 9000...')
      await sandbox.commands.run('/tmp/tcp-server 9000 > /tmp/tcp.log 2>&1 &')
      console.log('Server started')

      // Wait for server to start
      await new Promise(r => setTimeout(r, 1000))

      // Pause (in-VM TCP server running, no SDK stream)
      console.log('Pausing with in-VM TCP server running...')
      await sandbox.pause()
      console.log('Paused')

      // Resume
      console.log('Resuming...')
      const resumed = await Sandbox.connect(sandbox.sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
      console.log('Resumed')

      // Test portal works
      console.log('Testing portal...')
      const result = await resumed.commands.run('echo "portal works"', { timeoutMs: 30_000 })
      console.log(`Portal output: ${result.stdout.trim()}`)
      expect(result.exitCode).toBe(0)

      // Test TCP server still works - check process is running
      console.log('Checking TCP server process...')
      const psResult = await resumed.commands.run('pgrep -f tcp-server', { timeoutMs: 5_000 })
      console.log(`TCP server PIDs: ${psResult.stdout.trim()}`)

      console.log('=== TEST PASSED ===')
      await resumed.kill()
    } catch (error) {
      console.error('Test failed:', error)
      await sandbox.kill().catch(() => {})
      throw error
    }
  }, 120_000)

  test('gRPC server - no stream during pause', async () => {
    console.log('=== gRPC Server Test (no stream during pause) ===')

    const sandbox = await Sandbox.create(getTemplateId(), {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    try {
      // Upload gRPC server binary
      console.log('Uploading gRPC server binary...')
      const grpcBinary = fs.readFileSync(GRPC_SERVER_PATH)
      await sandbox.files.write('/tmp/grpc-server', grpcBinary)
      await sandbox.commands.run('chmod +x /tmp/grpc-server')
      console.log('Binary uploaded')

      // Start gRPC server using & (no SDK stream)
      console.log('Starting gRPC server on port 9001...')
      await sandbox.commands.run('/tmp/grpc-server 9001 > /tmp/grpc.log 2>&1 &')
      console.log('Server started')

      // Wait for server to start
      await new Promise(r => setTimeout(r, 1000))

      // Pause - no stream
      console.log('Pausing...')
      await sandbox.pause()
      console.log('Paused')

      // Resume
      console.log('Resuming...')
      const resumed = await Sandbox.connect(sandbox.sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
      console.log('Resumed')

      // Test portal works
      console.log('Testing portal...')
      const result = await resumed.commands.run('echo "portal works"', { timeoutMs: 30_000 })
      console.log(`Portal output: ${result.stdout.trim()}`)
      expect(result.exitCode).toBe(0)

      // Check gRPC server is still running
      console.log('Checking gRPC server process...')
      const ps = await resumed.commands.run('pgrep -f grpc-server', { timeoutMs: 5_000 })
      console.log(`gRPC server PIDs: ${ps.stdout.trim()}`)

      console.log('=== TEST PASSED ===')
      await resumed.kill()
    } catch (error) {
      console.error('Test failed:', error)
      await sandbox.kill().catch(() => {})
      throw error
    }
  }, 120_000)

  test('Portal via SDK - stream open during pause (ISSUE2 repro)', async () => {
    console.log('=== Portal Test (SDK stream OPEN during pause) - ISSUE2 ===')

    const sandbox = await Sandbox.create(getTemplateId(), {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    try {
      // Run a command first
      console.log('Running command before pause...')
      await sandbox.commands.run('echo "before"', { timeoutMs: 30_000 })

      // Start background process - THIS opens SDK stream to portal
      console.log('Starting background process (opens SDK->Portal stream)...')
      const bg = await sandbox.commands.run('sleep infinity', { background: true })
      console.log(`Background PID: ${bg.pid}`)

      // Pause with SDK stream open
      console.log('Pausing with SDK stream open...')
      await sandbox.pause()
      console.log('Paused')

      // Resume
      console.log('Resuming...')
      const resumed = await Sandbox.connect(sandbox.sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
      console.log('Resumed')

      // Test portal works
      console.log('Testing portal...')
      const result = await resumed.commands.run('echo "portal works"', { timeoutMs: 30_000 })
      console.log(`Portal output: ${result.stdout.trim()}`)
      expect(result.exitCode).toBe(0)

      console.log('=== TEST PASSED ===')
      await resumed.kill()
    } catch (error) {
      console.error('Test failed:', error)
      await sandbox.kill().catch(() => {})
      throw error
    }
  }, 120_000)

  test('Comparison: in-VM stream vs SDK stream', async () => {
    console.log('=== Comparison Test: in-VM stream vs SDK stream ===')
    console.log('This test checks if the issue is SDK->Portal stream or any stream')

    const sandbox = await Sandbox.create(getTemplateId(), {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    try {
      // Upload TCP server
      console.log('Uploading TCP server...')
      const tcpBinary = fs.readFileSync(TCP_SERVER_PATH)
      await sandbox.files.write('/tmp/tcp-server', tcpBinary)
      await sandbox.commands.run('chmod +x /tmp/tcp-server')

      // Start TCP server using & (no SDK stream)
      console.log('Starting TCP server...')
      await sandbox.commands.run('/tmp/tcp-server 9000 > /tmp/tcp.log 2>&1 &')
      await new Promise(r => setTimeout(r, 1000))

      // NO SDK background process - only in-VM stream

      // Pause
      console.log('Pausing with in-VM stream (no SDK stream)...')
      await sandbox.pause()
      console.log('Paused')

      // Resume
      console.log('Resuming...')
      const resumed = await Sandbox.connect(sandbox.sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
      console.log('Resumed')

      // Test portal
      console.log('Testing portal...')
      const result = await resumed.commands.run('echo "portal works"', { timeoutMs: 30_000 })
      console.log(`Portal output: ${result.stdout.trim()}`)
      expect(result.exitCode).toBe(0)

      // Check TCP server is still running
      console.log('Checking TCP server process...')
      const ps = await resumed.commands.run('pgrep -f tcp-server', { timeoutMs: 5_000 })
      console.log(`TCP server PIDs: ${ps.stdout.trim()}`)

      console.log('=== TEST PASSED ===')
      console.log('Conclusion: If this passes but ISSUE2 fails, the problem is SDK->Portal stream specifically')

      await resumed.kill()
    } catch (error) {
      console.error('Test failed:', error)
      await sandbox.kill().catch(() => {})
      throw error
    }
  }, 120_000)

  // CRITICAL TEST: External HTTP stream from host to VM during pause
  // Uses proper HTTP streaming which the gateway can proxy
  test('CRITICAL: External HTTP stream open during pause', async () => {
    console.log('=== CRITICAL TEST: External HTTP stream during pause ===')
    console.log('This test uses HTTP chunked streaming through gateway port forwarding')

    const sandbox = await Sandbox.create(getTemplateId(), {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    let receivedChunks: string[] = []
    let streamRequest: http.ClientRequest | null = null

    try {
      // Upload and start HTTP streaming server
      console.log('Uploading HTTP streaming server...')
      const httpBinary = fs.readFileSync(HTTP_SERVER_PATH)
      await sandbox.files.write('/tmp/http-server', httpBinary)
      await sandbox.commands.run('chmod +x /tmp/http-server')

      // Start HTTP server on port 8000
      console.log('Starting HTTP streaming server on port 8000...')
      await sandbox.commands.run('/tmp/http-server 8000 > /tmp/http.log 2>&1 &')
      await new Promise(r => setTimeout(r, 2000))

      // Verify server is running
      const healthCheck = await sandbox.commands.run('curl -s http://localhost:8000/health', { timeoutMs: 5_000 })
      console.log(`Health check inside VM: ${healthCheck.stdout.trim()}`)

      // Connect from HOST to VM via port forwarding
      const proxyHost = `8000-${sandbox.sandboxId}.dev.rebyte.app`
      console.log(`Connecting to HTTP streaming server via: http://${proxyHost}/stream`)

      // Start streaming request
      const streamPromise = new Promise<void>((resolve, reject) => {
        streamRequest = http.request({
          hostname: proxyHost,
          port: 80,
          method: 'GET',
          path: '/stream',
          headers: {
            'Host': proxyHost,
            'Accept': 'text/plain',
          },
        }, (res) => {
          console.log(`HTTP response status: ${res.statusCode}`)
          console.log(`HTTP response headers:`, res.headers)

          res.on('data', (chunk) => {
            const data = chunk.toString().trim()
            if (data) {
              console.log(`Received chunk: ${data}`)
              receivedChunks.push(data)
            }
          })
          res.on('end', () => {
            console.log('Stream ended')
            resolve()
          })
          res.on('error', (err) => {
            console.log(`Response error: ${err.message}`)
          })
        })

        streamRequest.on('error', (err) => {
          console.log(`Request error: ${err.message}`)
          // Don't reject - the stream might be interrupted by pause
        })

        streamRequest.setTimeout(180000)
        streamRequest.end()
      })

      // Wait to receive some data
      console.log('Waiting 5s to receive streaming data...')
      await new Promise(r => setTimeout(r, 5000))
      console.log(`Received ${receivedChunks.length} chunks before pause`)

      if (receivedChunks.length === 0) {
        console.log('WARNING: No chunks received - gateway might not support HTTP streaming')
      }

      // Pause with external HTTP stream open
      console.log('PAUSING with external HTTP stream open...')
      await sandbox.pause()
      console.log('Paused')

      // Resume
      console.log('Resuming...')
      const resumed = await Sandbox.connect(sandbox.sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
      console.log('Resumed')

      // Test portal - THIS IS THE KEY TEST
      console.log('Testing portal after resume with external stream...')
      const result = await resumed.commands.run('echo "portal works"', { timeoutMs: 30_000 })
      console.log(`Portal output: ${result.stdout.trim()}`)
      expect(result.exitCode).toBe(0)

      // Check HTTP server is still running
      console.log('Checking HTTP server process...')
      const ps = await resumed.commands.run('pgrep -f http-server', { timeoutMs: 5_000 })
      console.log(`HTTP server PIDs: ${ps.stdout.trim()}`)

      console.log('=== TEST PASSED ===')
      console.log(`Summary:`)
      console.log(`  - Chunks received before pause: ${receivedChunks.length}`)
      console.log(`  - Portal works after resume: YES`)
      console.log(`  - If ISSUE2 fails but this passes, issue is Portal-specific`)

      await resumed.kill()
    } catch (error) {
      console.error('Test failed:', error)
      await sandbox.kill().catch(() => {})
      throw error
    } finally {
      if (streamRequest) {
        streamRequest.destroy()
      }
    }
  }, 180_000)

})
