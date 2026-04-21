/**
 * Large File Upload Test
 *
 * Tests uploading large files (3MB) to verify the file upload limits.
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { Sandbox } from '../../src'
import {
  getGatewayConfig,
  printTestHeader,
  ensureProdApiKey,
} from './common'

const gatewayConfig = getGatewayConfig()
// Use the new template with fixed portal (100MB upload limit)
const TEMPLATE_ID = '411e2c1a-c561-4419-b791-33216034fdcc'

describe('Large File Upload', () => {
  beforeAll(async () => {
    await ensureProdApiKey()
  }, 30_000)

  test('should upload 10MB file', async () => {
    printTestHeader('10MB File Upload Test')

    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    try {
      // Generate 10MB of data
      const size = 10 * 1024 * 1024 // 10MB
      console.log(`\n1. Generating ${size} bytes (10MB) of data...`)
      const data = new Uint8Array(size)
      for (let i = 0; i < size; i++) {
        data[i] = i % 256
      }
      console.log(`   Generated ${data.length} bytes`)

      // Upload the file
      console.log('\n2. Uploading 3MB file...')
      const startTime = Date.now()
      const writeResult = await sandbox.files.write('/tmp/large-file.bin', data.buffer)
      const duration = Date.now() - startTime
      console.log(`   Written: ${writeResult.path} in ${duration}ms`)
      expect(writeResult.path).toBe('/tmp/large-file.bin')

      // Verify the file size
      console.log('\n3. Verifying file size...')
      const info = await sandbox.files.getInfo('/tmp/large-file.bin')
      console.log(`   Size: ${info.size} bytes`)
      expect(info.size).toBe(size)

      // Read back and verify (first and last few bytes)
      console.log('\n4. Reading file back and verifying...')
      const readStart = Date.now()
      const content = await sandbox.files.read('/tmp/large-file.bin', { format: 'bytes' })
      const readDuration = Date.now() - readStart
      console.log(`   Read ${content.length} bytes in ${readDuration}ms`)
      expect(content.length).toBe(size)
      
      // Verify first 10 bytes
      for (let i = 0; i < 10; i++) {
        expect(content[i]).toBe(i % 256)
      }
      // Verify last 10 bytes
      for (let i = size - 10; i < size; i++) {
        expect(content[i]).toBe(i % 256)
      }
      console.log('   Content verified!')

      console.log('\n=== Test Passed ===')
    } finally {
      await sandbox.kill()
      console.log('Sandbox killed')
    }
  }, 180_000) // 3 minute timeout
})
