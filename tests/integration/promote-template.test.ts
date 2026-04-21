/**
 * Promote Template Integration Test
 *
 * Tests the promote flow:
 * 1. Create sandbox → run a command → promote to template (full pause + copy)
 * 2. Create new sandbox from promoted template → verify instant resume
 *
 * Run:
 *   npx vitest run tests/integration/promote-template.test.ts
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
const TEMPLATE_ID = '69e930b1-1427-44f7-a5c7-080b791a0a24'

describe('Promote Template', () => {
  beforeAll(async () => {
    await ensureProdApiKey()
  }, 30_000)

  test('promote sandbox to template, then create sandbox from it', async () => {
    printTestHeader('Promote Template: sandbox → template → new sandbox')

    // 1. Create a sandbox with resource overrides (2 vCPU, 2GB memory)
    console.log('1. Creating sandbox with vcpu=2, memoryMb=2048...')

    // Use raw API to pass vcpu/memoryMb (SDK doesn't have these yet)
    const { ApiClient } = await import('../../src/api')
    const { ConnectionConfig } = await import('../../src/connectionConfig')
    const config = new ConnectionConfig(gatewayConfig)
    const apiClient = new ApiClient(config)

    const createRes = await apiClient.api.POST('/sandboxes', {
      body: {
        templateID: TEMPLATE_ID,
        timeout: 120,
        vcpu: 2,
        memoryMb: 2048,
      } as any,
    })
    if (createRes.error) {
      throw new Error(`Create failed: ${JSON.stringify(createRes.error)}`)
    }
    const sandboxId = (createRes.data as any).sandboxID
    const sandbox = await Sandbox.connect(sandboxId, {
      ...gatewayConfig,
      timeoutMs: 120_000,
    })
    console.log(`   Created: ${sandbox.sandboxId}`)

    // 2. Run a command to modify state
    console.log('2. Running command to modify sandbox state...')
    const result = await sandbox.commands.run('echo promoted > /home/user/promoted.txt', { timeoutMs: 10_000 })
    expect(result.exitCode).toBe(0)
    console.log('   File written')

    // 3. Promote to template (POST /templates with sandboxID)
    console.log('3. Promoting sandbox to template...')
    const promoteStart = Date.now()

    const promoteRes = await apiClient.api.POST('/templates' as any, {
      body: {
        sandboxID: sandbox.sandboxId,
      } as any,
    })

    const promoteMs = Date.now() - promoteStart
    console.log(`   Promote response status: ${promoteRes.response.status}`)

    if (promoteRes.error) {
      throw new Error(`Promote failed: ${JSON.stringify(promoteRes.error)}`)
    }

    const promoteData = promoteRes.data as any
    const newTemplateId = promoteData.templateId
    const baseTemplateId = promoteData.baseTemplateId
    console.log(`   New template: ${newTemplateId}`)
    console.log(`   Base template: ${baseTemplateId}`)
    console.log(`   Promote took ${promoteMs}ms`)
    expect(newTemplateId).toBeDefined()
    expect(baseTemplateId).toBeDefined()

    // 4. Create a new sandbox from the promoted template
    console.log('4. Creating sandbox from promoted template...')
    const createStart = Date.now()

    const newSandbox = await Sandbox.create(newTemplateId, {
      ...gatewayConfig,
      timeoutMs: 60_000,
    })

    const createMs = Date.now() - createStart
    console.log(`   New sandbox: ${newSandbox.sandboxId} (created in ${createMs}ms)`)

    // 5. Verify the sandbox is functional
    console.log('5. Verifying new sandbox is functional...')
    const whoami = await newSandbox.commands.run('whoami', { timeoutMs: 10_000 })
    console.log(`   whoami: ${whoami.stdout.trim()}`)
    expect(whoami.exitCode).toBe(0)

    console.log('=== PASS: promote template works ===')

    // Cleanup
    await newSandbox.kill()
    console.log('   New sandbox killed')
  }, 300_000) // 5 min test timeout
})
