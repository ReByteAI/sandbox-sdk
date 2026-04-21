/**
 * WebSocket Proxy Integration Test
 *
 * Tests that WebSocket connections can be proxied through the gateway and orchestrator
 * to a WebSocket server running inside the VM.
 *
 * NOTE: Requires a template with Python 3. Use the python template:
 *   TEST_TEMPLATE=python npx vitest run tests/integration/websocket.test.ts
 *
 * Run:
 *   npx vitest run tests/integration/websocket.test.ts
 */
import { describe, it, expect } from 'vitest'
import { Sandbox } from '../../src'
import WebSocket from 'ws'
import { getGatewayConfig } from './common'

const gatewayConfig = getGatewayConfig()

// Use large template for WebSocket test (has Python 3)
// Large template ID from common.ts
const LARGE_TEMPLATE_ID = '7a24777d-8ddf-436e-a80f-d77c2eccb598'

describe('WebSocket Proxy', () => {
  // Test 1: Direct WebSocket to gateway (no proxy)
  it('should connect to gateway ws-echo endpoint', async () => {
    console.log('\n==================================================')
    console.log('  Direct WebSocket Test (Gateway)')
    console.log('==================================================\n')

    const wsUrl = 'wss://dev.rebyte.app/ws-echo'
    console.log(`WebSocket URL: ${wsUrl}`)

    const messages: string[] = []

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl)

      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error('Direct WebSocket test timed out after 10s'))
      }, 10000)

      ws.on('open', () => {
        console.log('WebSocket connected!')
        ws.send('Hello gateway!')
      })

      ws.on('message', (data) => {
        const msg = data.toString()
        console.log(`Received: ${msg}`)
        messages.push(msg)
        clearTimeout(timeout)
        ws.close()
        resolve()
      })

      ws.on('error', (err) => {
        clearTimeout(timeout)
        console.log(`WebSocket error: ${err.message}`)
        reject(err)
      })

      ws.on('close', (code, reason) => {
        console.log(`WebSocket closed (code=${code}, reason=${reason?.toString() || 'none'})`)
      })
    })

    expect(messages).toHaveLength(1)
    expect(messages[0]).toBe('echo: Hello gateway!')
    console.log('✓ Direct gateway WebSocket works!')
  }, 30000)

  // Test 2: WebSocket through proxy to VM
  it('should proxy WebSocket connections to VM', async () => {
    console.log('\n==================================================')
    console.log('  WebSocket Proxy Test')
    console.log('  Template: large (has Python 3)')
    console.log('==================================================\n')

    // 1. Create sandbox with Python template
    console.log('1. Creating sandbox...')
    const sandbox = await Sandbox.create(LARGE_TEMPLATE_ID, { timeoutMs: 120_000, ...gatewayConfig })
    console.log(`   Sandbox created: ${sandbox.sandboxId}`)

    try {
      // 2. Start a simple WebSocket echo server
      console.log('\n2. Starting WebSocket echo server on port 8765...')

      // First check Python is available
      const pythonCheck = await sandbox.commands.run('python3 --version')
      console.log(`   Python: ${pythonCheck.stdout.trim()}`)

      // Install websockets library
      console.log('   Installing websockets library...')
      const installResult = await sandbox.commands.run('pip3 install websockets', { timeoutMs: 60_000 })
      if (installResult.exitCode !== 0) {
        throw new Error(`pip install failed: ${installResult.stderr}`)
      }

      // Start WebSocket echo server in background
      const serverScript = `
import asyncio
import websockets

async def echo(websocket):
    async for message in websocket:
        print(f"Received: {message}", flush=True)
        await websocket.send(f"echo: {message}")

async def main():
    print("WebSocket server starting on port 8765", flush=True)
    async with websockets.serve(echo, "0.0.0.0", 8765):
        print("WebSocket server ready", flush=True)
        await asyncio.Future()  # run forever

asyncio.run(main())
`
      await sandbox.files.write('/tmp/ws_server.py', serverScript)

      // Start server in background
      const serverProcess = await sandbox.commands.start('python3 /tmp/ws_server.py')
      console.log(`   Server process started: PID ${serverProcess.pid}`)

      // Wait for server to be ready
      await new Promise(resolve => setTimeout(resolve, 3000))

      // Verify server is running and check its output
      const psResult = await sandbox.commands.run('ps aux | grep python')
      console.log(`   Running processes:\n${psResult.stdout}`)

      // Check if server is listening on port 8765
      const netstatResult = await sandbox.commands.run('netstat -tlnp 2>/dev/null | grep 8765 || ss -tlnp | grep 8765')
      console.log(`   Port 8765 status: ${netstatResult.stdout.trim() || 'Not found'}`)

      // Test the WebSocket server from inside the VM using a Python client
      console.log('\n2b. Testing WebSocket from inside VM...')
      const clientScript = `
import asyncio
import websockets

async def test():
    uri = "ws://127.0.0.1:8765"
    async with websockets.connect(uri) as ws:
        await ws.send("test from inside")
        response = await ws.recv()
        print(f"Got response: {response}", flush=True)

asyncio.run(test())
`
      await sandbox.files.write('/tmp/ws_client.py', clientScript)
      const internalTest = await sandbox.commands.run('python3 /tmp/ws_client.py', { timeoutMs: 10000 })
      console.log(`   Internal test result: ${internalTest.stdout.trim()}`)
      if (internalTest.stderr) {
        console.log(`   Internal test stderr: ${internalTest.stderr.trim()}`)
      }
      if (internalTest.exitCode !== 0) {
        console.log(`   Internal test failed with exit code: ${internalTest.exitCode}`)
      } else {
        console.log('   ✓ WebSocket server works internally!')
      }

      // 3. Connect via WebSocket from outside
      console.log('\n3. Connecting via WebSocket...')

      // Build WebSocket URL through the proxy
      // Format: wss://<port>-<sandbox_id>.<domain>/
      const wsUrl = `wss://8765-${sandbox.sandboxId}.dev.rebyte.app/`
      console.log(`   WebSocket URL: ${wsUrl}`)

      const messages: string[] = []

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl)

        const timeout = setTimeout(async () => {
          ws.close()
          // Try to get server output on timeout
          const output = await serverProcess.wait({ timeoutMs: 500 }).catch(() => null)
          if (output) {
            console.log(`   [TIMEOUT] Server stdout: ${output.stdout}`)
            console.log(`   [TIMEOUT] Server stderr: ${output.stderr}`)
          }
          reject(new Error('WebSocket test timed out after 15s'))
        }, 15000)

        ws.on('open', () => {
          console.log('   WebSocket connected!')
          ws.send('Hello from test!')
        })

        ws.on('message', (data) => {
          const msg = data.toString()
          console.log(`   Received: ${msg}`)
          messages.push(msg)

          if (messages.length === 1) {
            // Send another message
            ws.send('Second message')
          } else if (messages.length === 2) {
            clearTimeout(timeout)
            ws.close()
            resolve()
          }
        })

        ws.on('error', (err) => {
          clearTimeout(timeout)
          console.log(`   WebSocket error: ${err.message}`)
          reject(err)
        })

        ws.on('close', (code, reason) => {
          console.log(`   WebSocket closed (code=${code}, reason=${reason?.toString() || 'none'})`)
        })
      })

      // Check server output regardless of success/failure
      const serverOutput = await serverProcess.wait({ timeoutMs: 1000 }).catch(() => null)
      if (serverOutput) {
        console.log(`   Server stdout: ${serverOutput.stdout}`)
        console.log(`   Server stderr: ${serverOutput.stderr}`)
      }

      // 4. Verify messages
      console.log('\n4. Verifying messages...')
      expect(messages).toHaveLength(2)
      expect(messages[0]).toBe('echo: Hello from test!')
      expect(messages[1]).toBe('echo: Second message')
      console.log('   ✓ All messages received correctly')

      console.log('\n=== WebSocket Test Passed ===')
    } finally {
      // Cleanup
      console.log('\nCleaning up...')
      await sandbox.kill()
      console.log('   Sandbox killed')
    }
  }, 180_000)
})
