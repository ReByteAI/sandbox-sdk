/**
 * ProcessService Connect RPC Tests
 *
 * These tests run against portal on localhost.
 * Run portal first: cargo run -p microsandbox-portal -- --port 49983
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { processClient, PORTAL_URL } from './setup'
import { Signal } from '../../src/envd/process/process_pb'

// Skip these tests unless PORTAL_URL is set or portal is running
const isPortalAvailable = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${PORTAL_URL}/health`)
    return res.ok
  } catch {
    return false
  }
}

describe('ProcessService', () => {
  beforeAll(async () => {
    const available = await isPortalAvailable()
    if (!available) {
      console.log(`Portal not available at ${PORTAL_URL}, skipping tests`)
    }
  })

  describe('list', () => {
    it('should return list of processes', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      const result = await processClient.list({})
      expect(result.processes).toBeDefined()
      expect(Array.isArray(result.processes)).toBe(true)
    })
  })

  describe('start', () => {
    it('should start a simple command and stream output', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      const events: any[] = []

      const stream = processClient.start({
        process: { cmd: 'echo', args: ['hello world'] },
      })

      for await (const event of stream) {
        events.push(event)
      }

      // Should have start, data, and end events
      expect(events.length).toBeGreaterThan(0)
      expect(events[0].event?.event.case).toBe('start')

      const endEvent = events.find((e) => e.event?.event.case === 'end')
      expect(endEvent).toBeDefined()
      expect(endEvent.event.event.value.exitCode).toBe(0)
    })

    it('should start command with PTY', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      const events: any[] = []

      const stream = processClient.start({
        process: { cmd: 'echo', args: ['pty test'] },
        pty: { size: { cols: 80, rows: 24 } },
      })

      for await (const event of stream) {
        events.push(event)
      }

      expect(events[0].event?.event.case).toBe('start')
    })

    it('should start command with tag', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      const stream = processClient.start({
        process: { cmd: 'sleep', args: ['0.1'] },
        tag: 'test-tagged-process',
      })

      const events: any[] = []
      for await (const event of stream) {
        events.push(event)
      }

      expect(events[0].event?.event.case).toBe('start')
    })

    it('should handle non-existent command', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      const stream = processClient.start({
        process: { cmd: 'nonexistent-command-12345' },
      })

      const events: any[] = []
      for await (const event of stream) {
        events.push(event)
      }

      const endEvent = events.find((e) => e.event?.event.case === 'end')
      expect(endEvent.event.event.value.exitCode).not.toBe(0)
    })

    it('should handle command with env vars', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      const stream = processClient.start({
        process: {
          cmd: 'sh',
          args: ['-c', 'echo $MY_VAR'],
          envs: { MY_VAR: 'test-value' },
        },
      })

      const events: any[] = []
      for await (const event of stream) {
        events.push(event)
      }

      // Extract output data from data events using protobuf oneof structure
      const dataEvents = events.filter((e) => e.event?.event.case === 'data')
      const output = dataEvents
        .map((e) => {
          const outputOneof = e.event?.event?.value?.output
          if (outputOneof?.value) {
            return new TextDecoder().decode(outputOneof.value)
          }
          return ''
        })
        .join('')

      expect(output).toContain('test-value')
    })

    it('should handle command with cwd', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      const stream = processClient.start({
        process: { cmd: 'pwd', cwd: '/tmp' },
      })

      const events: any[] = []
      for await (const event of stream) {
        events.push(event)
      }

      // Extract output data from data events using protobuf oneof structure
      const dataEvents = events.filter((e) => e.event?.event.case === 'data')
      const output = dataEvents
        .map((e) => {
          const outputOneof = e.event?.event?.value?.output
          if (outputOneof?.case === 'stdout' && outputOneof?.value) {
            return new TextDecoder().decode(outputOneof.value)
          }
          return ''
        })
        .join('')

      expect(output.trim()).toBe('/tmp')
    })
  })

  describe('sendInput', () => {
    it('should send input to running process', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      // Start a cat process
      const stream = processClient.start({
        process: { cmd: 'cat' },
        tag: 'input-test',
      })

      const iterator = stream[Symbol.asyncIterator]()
      const startEvent = await iterator.next()
      const pid = startEvent.value.event.event.value.pid

      // Send input
      await processClient.sendInput({
        process: { selector: { case: 'pid', value: pid } },
        input: { input: { case: 'stdin', value: new TextEncoder().encode('hello\n') } },
      })

      // Send EOF (Ctrl+D) via signal
      await processClient.sendSignal({
        process: { selector: { case: 'pid', value: pid } },
        signal: Signal.SIGTERM,
      })

      // Collect remaining events
      const events: any[] = [startEvent.value]
      for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
        events.push(event)
      }

      expect(events.length).toBeGreaterThan(1)
    })
  })

  describe('sendSignal', () => {
    it('should send SIGTERM to process', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      const stream = processClient.start({
        process: { cmd: 'sleep', args: ['60'] },
      })

      const iterator = stream[Symbol.asyncIterator]()
      const startEvent = await iterator.next()
      const pid = startEvent.value.event.event.value.pid

      // Send SIGTERM
      await processClient.sendSignal({
        process: { selector: { case: 'pid', value: pid } },
        signal: Signal.SIGTERM,
      })

      // Collect events until end
      const events: any[] = []
      for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
        events.push(event)
      }

      const endEvent = events.find((e) => e.event?.event.case === 'end')
      expect(endEvent).toBeDefined()
    })

    it('should send SIGKILL to process', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      const stream = processClient.start({
        process: { cmd: 'sleep', args: ['60'] },
      })

      const iterator = stream[Symbol.asyncIterator]()
      const startEvent = await iterator.next()
      const pid = startEvent.value.event.event.value.pid

      await processClient.sendSignal({
        process: { selector: { case: 'pid', value: pid } },
        signal: Signal.SIGKILL,
      })

      const events: any[] = []
      for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
        events.push(event)
      }

      const endEvent = events.find((e) => e.event?.event.case === 'end')
      expect(endEvent).toBeDefined()
    })
  })

  describe('update (PTY resize)', () => {
    it('should resize PTY', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      const stream = processClient.start({
        process: { cmd: 'sleep', args: ['1'] },
        pty: { size: { cols: 80, rows: 24 } },
      })

      const iterator = stream[Symbol.asyncIterator]()
      const startEvent = await iterator.next()
      const pid = startEvent.value.event.event.value.pid

      // Resize PTY
      await processClient.update({
        process: { selector: { case: 'pid', value: pid } },
        pty: { size: { cols: 120, rows: 40 } },
      })

      // Should not throw
      expect(true).toBe(true)

      // Clean up
      await processClient.sendSignal({
        process: { selector: { case: 'pid', value: pid } },
        signal: Signal.SIGTERM,
      })
    })
  })
})
