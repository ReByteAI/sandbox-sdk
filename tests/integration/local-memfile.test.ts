/**
 * Local Memfile Lifecycle Test
 *
 * Verifies the local-only memfile design:
 * 1. Create sandbox, write data, pause
 * 2. Verify GCS has only rootfs (no memfile/snapfile)
 * 3. Verify local disk has memfile+snapfile
 * 4. Resume → full restore (fast, data intact, coldStart=false)
 * 5. Pause again
 * 6. Delete local memfile+snapfile
 * 7. Resume → cold start fallback (data intact from rootfs, coldStart=true)
 *
 * Run:
 *   npx vitest run tests/integration/local-memfile.test.ts
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { Sandbox } from '../../src'
import { execSync } from 'child_process'
import { existsSync, readdirSync, rmSync } from 'fs'
import {
  getTemplateId,
  getGatewayConfig,
  getNamespace,
  printTestHeader,
  ensureProdApiKey,
} from './common'

const gatewayConfig = getGatewayConfig()
const TEMPLATE_ID = getTemplateId()
const NAMESPACE = getNamespace()
const LOCAL_BUILDS_DIR = '/mnt/storage/builds'

/** Get the latest build_id for a sandbox from the local builds dir */
function findLocalBuild(sandboxId: string): { buildId: string; path: string } | null {
  if (!existsSync(LOCAL_BUILDS_DIR)) return null

  // Walk builds, find ones with snapshot.json mentioning this sandbox
  const dirs = readdirSync(LOCAL_BUILDS_DIR).filter(d => {
    const snapshotPath = `${LOCAL_BUILDS_DIR}/${d}/snapshot.json`
    if (!existsSync(snapshotPath)) return false
    try {
      const json = JSON.parse(require('fs').readFileSync(snapshotPath, 'utf8'))
      return json.sandbox_name === sandboxId
    } catch { return false }
  })

  if (dirs.length === 0) return null

  // Sort by mtime descending, return latest
  dirs.sort((a, b) => {
    const mtimeA = require('fs').statSync(`${LOCAL_BUILDS_DIR}/${a}`).mtimeMs
    const mtimeB = require('fs').statSync(`${LOCAL_BUILDS_DIR}/${b}`).mtimeMs
    return mtimeB - mtimeA
  })

  return { buildId: dirs[0], path: `${LOCAL_BUILDS_DIR}/${dirs[0]}` }
}

/** List files in a GCS snapshot dir */
function gcsListFiles(sandboxId: string, buildId: string): string[] {
  const gcsDir = `gs://microsandbox/sandboxes/${NAMESPACE}/${sandboxId}/paused/${buildId}/`
  try {
    const output = execSync(`gsutil ls ${gcsDir}`, { encoding: 'utf8', timeout: 15_000 })
    return output.trim().split('\n').map(f => f.split('/').pop()!).filter(Boolean)
  } catch {
    return []
  }
}

/** Resume sandbox via raw HTTP to get coldStart field */
async function resumeSandbox(sandboxId: string, opts?: { buildID?: string; coldStart?: boolean }): Promise<{
  sandboxId: string
  coldStart: boolean
}> {
  const url = `${gatewayConfig.apiUrl}/sandboxes/${sandboxId}/resume`
  const body: Record<string, unknown> = { timeout: 300 }
  if (opts?.buildID) body.buildID = opts.buildID
  if (opts?.coldStart !== undefined) body.coldStart = opts.coldStart

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': gatewayConfig.apiKey,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Resume failed (${res.status}): ${text}`)
  }

  const data = await res.json() as Record<string, unknown>
  return {
    sandboxId: data.sandboxID as string,
    coldStart: data.coldStart as boolean,
    buildID: data.buildID as string | undefined,
  }
}

/** Fetch sandbox info via GET /sandboxes/{id} to check buildID and coldStart */
async function getSandboxInfo(sandboxId: string): Promise<{
  state: string
  buildID?: string
  coldStart?: boolean
  templateID: string
}> {
  const url = `${gatewayConfig.apiUrl}/sandboxes/${sandboxId}`
  const res = await fetch(url, {
    headers: { 'X-API-Key': gatewayConfig.apiKey },
  })
  if (!res.ok) throw new Error(`getInfo failed: ${res.status}`)
  const data = await res.json() as Record<string, unknown>
  return {
    state: data.state as string,
    buildID: data.buildID as string | undefined,
    coldStart: data.coldStart as boolean | undefined,
    templateID: data.templateID as string,
  }
}

describe('Local Memfile Lifecycle', () => {
  beforeAll(async () => {
    await ensureProdApiKey()
  }, 30_000)

  test('full restore with local memfile, cold start without', async () => {
    printTestHeader('Local Memfile Lifecycle')

    // ---------------------------------------------------------------
    // Step 1: Create sandbox and write data
    // ---------------------------------------------------------------
    console.log('\n1. Creating sandbox...')
    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    const sandboxId = sandbox.sandboxId
    console.log(`   Created: ${sandboxId}`)

    try {
      const testContent = `local-memfile-test-${Date.now()}`
      await sandbox.files.write('/code/test-data.txt', testContent)
      console.log(`   Wrote /code/test-data.txt: "${testContent}"`)

      // ---------------------------------------------------------------
      // Step 2: Pause
      // ---------------------------------------------------------------
      console.log('\n2. Pausing...')
      const buildId = await sandbox.pause()
      console.log(`   Paused: build_id=${buildId}`)
      expect(buildId).toBeTruthy()

      // ---------------------------------------------------------------
      // Step 3: Verify GCS has only rootfs (no memfile/snapfile)
      // ---------------------------------------------------------------
      console.log('\n3. Checking GCS...')
      const gcsFiles = gcsListFiles(sandboxId, buildId as string)
      console.log(`   GCS files: ${gcsFiles.join(', ')}`)

      expect(gcsFiles).toContain('snapshot.json')
      expect(gcsFiles).toContain('rootfs')
      expect(gcsFiles).toContain('rootfs.header')
      expect(gcsFiles).not.toContain('memfile')
      expect(gcsFiles).not.toContain('memfile.header')
      expect(gcsFiles).not.toContain('snapfile')

      // ---------------------------------------------------------------
      // Step 4: Verify local disk has memfile+snapfile
      // ---------------------------------------------------------------
      console.log('\n4. Checking local disk...')
      const localBuild = findLocalBuild(sandboxId)
      expect(localBuild).not.toBeNull()
      console.log(`   Local build: ${localBuild!.path}`)

      const localFiles = readdirSync(localBuild!.path)
      console.log(`   Local files: ${localFiles.join(', ')}`)
      expect(localFiles).toContain('memfile')
      expect(localFiles).toContain('memfile.header')
      expect(localFiles).toContain('snapfile')

      // ---------------------------------------------------------------
      // Step 5: Resume → should be full restore (coldStart=false)
      // ---------------------------------------------------------------
      console.log('\n5. Resuming (local memfile exists)...')
      const resumeResult = await resumeSandbox(sandboxId)
      console.log(`   coldStart: ${resumeResult.coldStart}`)
      expect(resumeResult.coldStart).toBe(false)

      // Verify getInfo reflects the resume state
      const info1 = await getSandboxInfo(sandboxId)
      console.log(`   getInfo: state=${info1.state}, buildID=${info1.buildID}, coldStart=${info1.coldStart}, templateID=${info1.templateID}`)
      expect(info1.state).toBe('running')
      expect(info1.buildID).toBeDefined()
      expect(info1.coldStart).toBe(false)
      expect(info1.templateID).toBeDefined()

      // Verify data intact
      const reconnected = await Sandbox.connect(sandboxId, {
        ...gatewayConfig,
      })
      const content1 = await reconnected.files.read('/code/test-data.txt')
      console.log(`   Data intact: "${content1}"`)
      expect(content1).toBe(testContent)

      // ---------------------------------------------------------------
      // Step 6: Pause again
      // ---------------------------------------------------------------
      console.log('\n6. Pausing again...')
      const buildId2 = await reconnected.pause()
      console.log(`   Paused: build_id=${buildId2}`)

      // ---------------------------------------------------------------
      // Step 7: Delete local memfile+snapfile
      // ---------------------------------------------------------------
      console.log('\n7. Deleting local memfile+snapfile...')
      const localBuild2 = findLocalBuild(sandboxId)
      expect(localBuild2).not.toBeNull()

      const memfilePath = `${localBuild2!.path}/memfile`
      const memfileHeaderPath = `${localBuild2!.path}/memfile.header`
      const snapfilePath = `${localBuild2!.path}/snapfile`

      for (const f of [memfilePath, memfileHeaderPath, snapfilePath]) {
        if (existsSync(f)) {
          execSync(`sudo rm -f "${f}"`, { timeout: 5_000 })
          console.log(`   Deleted: ${f.split('/').pop()}`)
        }
      }

      // ---------------------------------------------------------------
      // Step 8: Resume → should be cold start (coldStart=true)
      // ---------------------------------------------------------------
      console.log('\n8. Resuming (no local memfile)...')
      const resumeResult2 = await resumeSandbox(sandboxId)
      console.log(`   coldStart: ${resumeResult2.coldStart}`)
      expect(resumeResult2.coldStart).toBe(true)

      // Verify getInfo reflects cold start
      const info2 = await getSandboxInfo(sandboxId)
      console.log(`   getInfo: state=${info2.state}, buildID=${info2.buildID}, coldStart=${info2.coldStart}, templateID=${info2.templateID}`)
      expect(info2.state).toBe('running')
      expect(info2.buildID).toBeDefined()
      expect(info2.coldStart).toBe(true)
      expect(info2.templateID).toBeDefined()

      // Verify data still intact (from rootfs diffs)
      const reconnected2 = await Sandbox.connect(sandboxId, {
        ...gatewayConfig,
      })
      const content2 = await reconnected2.files.read('/code/test-data.txt')
      console.log(`   Data intact after cold start: "${content2}"`)
      expect(content2).toBe(testContent)

      // Cleanup
      await reconnected2.kill()
      console.log('\n   Test passed!')

    } catch (e) {
      // Cleanup on failure
      try { await sandbox.kill() } catch {}
      throw e
    }
  }, 600_000) // 10 min timeout
})
