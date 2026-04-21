/**
 * Webhook Integration Tests
 *
 * Tests sandbox lifecycle webhook delivery for all event types:
 * - sandbox.started (on create)
 * - sandbox.stopped (on manual kill)
 * - sandbox.paused (on manual pause)
 * - sandbox.hibernated (on manual hibernate)
 * - sandbox.resumed (on connect/resume)
 *
 * Uses a local HTTP server to capture webhook POSTs from the gateway.
 *
 * Run:
 *   npx vitest run tests/integration/webhook.test.ts
 *
 * Run specific test:
 *   npx vitest run tests/integration/webhook.test.ts -t "webhook on create and kill"
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { Sandbox } from '../../src'
import http from 'http'
import {
  getTemplateId,
  getGatewayConfig,
  getEnvironment,
  getDatabaseUrl,
  printTestHeader,
  ensureProdApiKey,
} from './common'

const gatewayConfig = getGatewayConfig()
const DB_URL = getDatabaseUrl()
const TEMPLATE_ID = getTemplateId()

/**
 * Webhook payload structure sent by the gateway.
 */
interface WebhookPayload {
  event: string
  sandboxId: string
  namespace: string
  templateId: string
  timestamp: string
  reason: string
}

/**
 * Start a local HTTP server that captures webhook POST requests.
 * Returns the server, its URL, and a list of received payloads.
 *
 * The gateway must be able to reach this server. In dev, we use the
 * build machine's external IP. The webhook server binds to 0.0.0.0.
 */
async function startWebhookServer(): Promise<{
  server: http.Server
  url: string
  payloads: WebhookPayload[]
  close: () => Promise<void>
}> {
  const payloads: WebhookPayload[] = []

  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        try {
          const payload = JSON.parse(body) as WebhookPayload
          console.log(`  [webhook] Received: ${payload.event} (reason: ${payload.reason})`)
          payloads.push(payload)
        } catch (e) {
          console.log(`  [webhook] Failed to parse body: ${body}`)
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
      })
    } else {
      res.writeHead(404)
      res.end()
    }
  })

  // Listen on a random port on all interfaces
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
  const port = (server.address() as any).port

  // Determine the externally reachable URL
  // The gateway runs on the build machine — we need the IP this machine
  // is reachable at from there. For local dev, use the machine's hostname.
  const { execSync } = require('child_process')
  let host: string
  try {
    // Try to get external IP (works on GCP)
    host = execSync(
      "curl -s -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip 2>/dev/null || hostname -I | awk '{print $1}'",
      { encoding: 'utf8', timeout: 5000 }
    ).trim()
  } catch {
    host = '127.0.0.1'
  }

  const url = `http://${host}:${port}`
  console.log(`  [webhook] Server listening at ${url}`)

  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
    })

  return { server, url, payloads, close }
}

/**
 * Wait for a specific webhook event to appear in the payloads list.
 */
async function waitForWebhook(
  payloads: WebhookPayload[],
  event: string,
  sandboxId: string,
  timeoutMs = 15_000
): Promise<WebhookPayload> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const match = payloads.find(
      (p) => p.event === event && p.sandboxId === sandboxId
    )
    if (match) return match
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(
    `Timed out waiting for webhook event=${event} sandboxId=${sandboxId} after ${timeoutMs}ms. ` +
    `Received events: ${payloads.map((p) => `${p.event}(${p.sandboxId})`).join(', ') || 'none'}`
  )
}

describe('Webhook', () => {
  beforeAll(async () => {
    await ensureProdApiKey()
  }, 30_000)

  test('webhook on create and kill', async () => {
    printTestHeader('Webhook: Create + Kill')

    const { url, payloads, close } = await startWebhookServer()

    try {
      // 1. Create sandbox with webhookUrl
      console.log('\n1. Creating sandbox with webhookUrl...')
      const sandbox = await Sandbox.create(TEMPLATE_ID, {
        ...gatewayConfig,
        timeoutMs: 300_000,
        webhookUrl: url,
      })
      const sandboxId = sandbox.sandboxId
      console.log(`   Sandbox created: ${sandboxId}`)

      // 2. Wait for sandbox.started webhook
      console.log('\n2. Waiting for sandbox.started webhook...')
      const startedPayload = await waitForWebhook(payloads, 'sandbox.started', sandboxId)
      expect(startedPayload.event).toBe('sandbox.started')
      expect(startedPayload.sandboxId).toBe(sandboxId)
      expect(startedPayload.reason).toBe('created')
      expect(startedPayload.timestamp).toBeTruthy()
      console.log(`   Received sandbox.started: reason=${startedPayload.reason}`)

      // 3. Kill sandbox
      console.log('\n3. Killing sandbox...')
      await sandbox.kill()
      console.log('   Killed')

      // 4. Wait for sandbox.stopped webhook
      console.log('\n4. Waiting for sandbox.stopped webhook...')
      const stoppedPayload = await waitForWebhook(payloads, 'sandbox.stopped', sandboxId)
      expect(stoppedPayload.event).toBe('sandbox.stopped')
      expect(stoppedPayload.sandboxId).toBe(sandboxId)
      expect(stoppedPayload.reason).toBe('manual_stop')
      console.log(`   Received sandbox.stopped: reason=${stoppedPayload.reason}`)

      console.log('\n=== Webhook Create+Kill Test Passed ===')
    } finally {
      await close()
    }
  }, 120_000)

  test('webhook on pause and resume', async () => {
    printTestHeader('Webhook: Pause + Resume')

    const { url, payloads, close } = await startWebhookServer()

    try {
      // 1. Create sandbox with webhookUrl
      console.log('\n1. Creating sandbox with webhookUrl...')
      const sandbox = await Sandbox.create(TEMPLATE_ID, {
        ...gatewayConfig,
        timeoutMs: 300_000,
        webhookUrl: url,
      })
      const sandboxId = sandbox.sandboxId
      console.log(`   Sandbox created: ${sandboxId}`)

      // Wait for started webhook
      await waitForWebhook(payloads, 'sandbox.started', sandboxId)
      console.log('   sandbox.started received')

      // 2. Pause sandbox (full snapshot)
      console.log('\n2. Pausing sandbox (full snapshot)...')
      await sandbox.pause()
      console.log('   Paused')

      // 3. Wait for sandbox.paused webhook
      console.log('\n3. Waiting for sandbox.paused webhook...')
      const pausedPayload = await waitForWebhook(payloads, 'sandbox.paused', sandboxId)
      expect(pausedPayload.event).toBe('sandbox.paused')
      expect(pausedPayload.sandboxId).toBe(sandboxId)
      expect(pausedPayload.reason).toBe('manual_pause')
      console.log(`   Received sandbox.paused: reason=${pausedPayload.reason}`)

      // 4. Resume sandbox
      console.log('\n4. Resuming sandbox...')
      const resumed = await Sandbox.connect(sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
      console.log(`   Resumed: ${resumed.sandboxId}`)

      // 5. Wait for sandbox.resumed webhook
      console.log('\n5. Waiting for sandbox.resumed webhook...')
      const resumedPayload = await waitForWebhook(payloads, 'sandbox.resumed', sandboxId)
      expect(resumedPayload.event).toBe('sandbox.resumed')
      expect(resumedPayload.sandboxId).toBe(sandboxId)
      expect(resumedPayload.reason).toBe('resumed')
      console.log(`   Received sandbox.resumed: reason=${resumedPayload.reason}`)

      // Cleanup
      await resumed.kill()
      // Wait for stop webhook (webhook_url persisted from snapshot)
      await waitForWebhook(payloads, 'sandbox.stopped', sandboxId)
      console.log('   sandbox.stopped received after kill')

      // Clean up DB
      const { execSync } = require('child_process')
      try {
        execSync(
          `psql "${DB_URL}" -c "DELETE FROM sandbox_snapshots WHERE sandbox_id = '${sandboxId}';"`,
          { encoding: 'utf8', timeout: 10_000 }
        )
      } catch (e) {
        // Ignore
      }

      console.log('\n=== Webhook Pause+Resume Test Passed ===')
    } finally {
      await close()
    }
  }, 300_000)

  test('webhook on hibernate and resume', async () => {
    printTestHeader('Webhook: Hibernate + Resume')

    const { url, payloads, close } = await startWebhookServer()

    try {
      // 1. Create sandbox with webhookUrl
      console.log('\n1. Creating sandbox with webhookUrl...')
      const sandbox = await Sandbox.create(TEMPLATE_ID, {
        ...gatewayConfig,
        timeoutMs: 300_000,
        webhookUrl: url,
      })
      const sandboxId = sandbox.sandboxId
      console.log(`   Sandbox created: ${sandboxId}`)

      await waitForWebhook(payloads, 'sandbox.started', sandboxId)
      console.log('   sandbox.started received')

      // 2. Hibernate sandbox (rootfs-only)
      console.log('\n2. Hibernating sandbox...')
      await sandbox.hibernate()
      console.log('   Hibernated')

      // 3. Wait for sandbox.hibernated webhook
      console.log('\n3. Waiting for sandbox.hibernated webhook...')
      const hibernatedPayload = await waitForWebhook(payloads, 'sandbox.hibernated', sandboxId)
      expect(hibernatedPayload.event).toBe('sandbox.hibernated')
      expect(hibernatedPayload.sandboxId).toBe(sandboxId)
      expect(hibernatedPayload.reason).toBe('manual_hibernate')
      console.log(`   Received sandbox.hibernated: reason=${hibernatedPayload.reason}`)

      // 4. Resume sandbox (cold boot)
      console.log('\n4. Resuming sandbox (cold boot)...')
      const resumed = await Sandbox.connect(sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
      console.log(`   Resumed: ${resumed.sandboxId}`)

      // 5. Wait for sandbox.resumed webhook
      console.log('\n5. Waiting for sandbox.resumed webhook...')
      const resumedPayload = await waitForWebhook(payloads, 'sandbox.resumed', sandboxId)
      expect(resumedPayload.event).toBe('sandbox.resumed')
      expect(resumedPayload.sandboxId).toBe(sandboxId)
      expect(resumedPayload.reason).toBe('resumed')
      console.log(`   Received sandbox.resumed: reason=${resumedPayload.reason}`)

      // Cleanup
      await resumed.kill()
      await waitForWebhook(payloads, 'sandbox.stopped', sandboxId)
      console.log('   sandbox.stopped received after kill')

      // Clean up DB
      const { execSync } = require('child_process')
      try {
        execSync(
          `psql "${DB_URL}" -c "DELETE FROM sandbox_snapshots WHERE sandbox_id = '${sandboxId}';"`,
          { encoding: 'utf8', timeout: 10_000 }
        )
      } catch (e) {
        // Ignore
      }

      console.log('\n=== Webhook Hibernate+Resume Test Passed ===')
    } finally {
      await close()
    }
  }, 300_000)

  test('webhook url override on resume', async () => {
    printTestHeader('Webhook: URL Override on Resume')

    const { url: url1, payloads: payloads1, close: close1 } = await startWebhookServer()
    const { url: url2, payloads: payloads2, close: close2 } = await startWebhookServer()

    try {
      // 1. Create sandbox with webhookUrl pointing to server 1
      console.log('\n1. Creating sandbox with webhookUrl (server 1)...')
      const sandbox = await Sandbox.create(TEMPLATE_ID, {
        ...gatewayConfig,
        timeoutMs: 300_000,
        webhookUrl: url1,
      })
      const sandboxId = sandbox.sandboxId
      console.log(`   Sandbox created: ${sandboxId}`)

      await waitForWebhook(payloads1, 'sandbox.started', sandboxId)
      console.log('   sandbox.started received on server 1')

      // 2. Hibernate
      console.log('\n2. Hibernating sandbox...')
      await sandbox.hibernate()
      await waitForWebhook(payloads1, 'sandbox.hibernated', sandboxId)
      console.log('   sandbox.hibernated received on server 1')

      // 3. Resume with webhookUrl pointing to server 2 (override)
      console.log('\n3. Resuming with webhookUrl override (server 2)...')
      const resumed = await Sandbox.connect(sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
        webhookUrl: url2,
      })
      console.log(`   Resumed: ${resumed.sandboxId}`)

      // 4. sandbox.resumed should go to server 2
      const resumedPayload = await waitForWebhook(payloads2, 'sandbox.resumed', sandboxId)
      expect(resumedPayload.event).toBe('sandbox.resumed')
      expect(resumedPayload.sandboxId).toBe(sandboxId)
      console.log('   sandbox.resumed received on server 2 (override works)')

      // 5. Kill — should also go to server 2
      await resumed.kill()
      const stoppedPayload = await waitForWebhook(payloads2, 'sandbox.stopped', sandboxId)
      expect(stoppedPayload.event).toBe('sandbox.stopped')
      console.log('   sandbox.stopped received on server 2')

      // Verify server 1 did NOT receive resumed/stopped events
      const server1ResumedEvents = payloads1.filter(
        (p) => p.event === 'sandbox.resumed' && p.sandboxId === sandboxId
      )
      expect(server1ResumedEvents.length).toBe(0)
      console.log('   Server 1 did NOT receive resumed/stopped (correct)')

      // Clean up DB
      const { execSync } = require('child_process')
      try {
        execSync(
          `psql "${DB_URL}" -c "DELETE FROM sandbox_snapshots WHERE sandbox_id = '${sandboxId}';"`,
          { encoding: 'utf8', timeout: 10_000 }
        )
      } catch (e) {
        // Ignore
      }

      console.log('\n=== Webhook URL Override Test Passed ===')
    } finally {
      await Promise.allSettled([close1(), close2()])
    }
  }, 300_000)

  test('all webhook events in full lifecycle', async () => {
    printTestHeader('Webhook: Full Lifecycle')

    const { url, payloads, close } = await startWebhookServer()

    try {
      // 1. Create
      console.log('\n1. Creating sandbox...')
      const sandbox = await Sandbox.create(TEMPLATE_ID, {
        ...gatewayConfig,
        timeoutMs: 300_000,
        webhookUrl: url,
      })
      const sandboxId = sandbox.sandboxId
      await waitForWebhook(payloads, 'sandbox.started', sandboxId)
      console.log('   sandbox.started received')

      // 2. Pause
      console.log('\n2. Pausing sandbox...')
      await sandbox.pause()
      await waitForWebhook(payloads, 'sandbox.paused', sandboxId)
      console.log('   sandbox.paused received')

      // 3. Resume
      console.log('\n3. Resuming sandbox...')
      const resumed1 = await Sandbox.connect(sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
      await waitForWebhook(payloads, 'sandbox.resumed', sandboxId)
      console.log('   sandbox.resumed received')

      // 4. Hibernate
      console.log('\n4. Hibernating sandbox...')
      await resumed1.hibernate()
      await waitForWebhook(payloads, 'sandbox.hibernated', sandboxId)
      console.log('   sandbox.hibernated received')

      // 5. Resume again (cold boot)
      console.log('\n5. Resuming sandbox (cold boot)...')
      const resumed2 = await Sandbox.connect(sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
      // Wait for the second resumed event
      await new Promise((r) => setTimeout(r, 2000))
      const resumedEvents = payloads.filter(
        (p) => p.event === 'sandbox.resumed' && p.sandboxId === sandboxId
      )
      expect(resumedEvents.length).toBe(2)
      console.log('   sandbox.resumed (2nd) received')

      // 6. Kill
      console.log('\n6. Killing sandbox...')
      await resumed2.kill()
      await waitForWebhook(payloads, 'sandbox.stopped', sandboxId)
      console.log('   sandbox.stopped received')

      // Verify all events received
      const events = payloads
        .filter((p) => p.sandboxId === sandboxId)
        .map((p) => `${p.event}(${p.reason})`)
      console.log(`\n   All events: ${events.join(' → ')}`)

      expect(events).toContain('sandbox.started(created)')
      expect(events).toContain('sandbox.paused(manual_pause)')
      expect(events).toContain('sandbox.hibernated(manual_hibernate)')
      expect(events).toContain('sandbox.stopped(manual_stop)')
      // Two resumed events
      const resumedCount = events.filter((e) => e === 'sandbox.resumed(resumed)').length
      expect(resumedCount).toBe(2)

      // Clean up DB
      const { execSync } = require('child_process')
      try {
        execSync(
          `psql "${DB_URL}" -c "DELETE FROM sandbox_snapshots WHERE sandbox_id = '${sandboxId}';"`,
          { encoding: 'utf8', timeout: 10_000 }
        )
      } catch (e) {
        // Ignore
      }

      console.log('\n=== Full Lifecycle Webhook Test Passed ===')
    } finally {
      await close()
    }
  }, 600_000)
})
