/**
 * Pause/Resume Integration Tests
 *
 * Tests sandbox pause and resume functionality:
 * - Manual pause and resume with persistence
 * - Cold start (fresh boot) with persistence
 * - Auto-pause on timeout
 * - Connect during pause (409 error)
 * - Multiple snapshot persistence
 * - GCS upload verification
 *
 * Run:
 *   npx vitest run tests/integration/pause-resume.test.ts
 *
 * Run specific test:
 *   npx vitest run tests/integration/pause-resume.test.ts -t "cold start"
 *
 * With large template (4GB):
 *   TEST_TEMPLATE=large npx vitest run tests/integration/pause-resume.test.ts
 *
 * Note: These tests use the small template by default for faster pause/resume.
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { Sandbox } from '../../src'
import {
  getTemplateId,
  getGatewayConfig,
  getEnvironment,
  getDatabaseUrl,
  printTestHeader,
  ensureProdApiKey,
  getNamespace,
} from './common'

const gatewayConfig = getGatewayConfig()
const testEnv = getEnvironment()
const DB_URL = getDatabaseUrl()

// Use template from TEST_TEMPLATE env var (default: small)
const TEMPLATE_ID = getTemplateId()

// Helper to check and print pause storage paths
async function assertPauseStoragePaths(sandboxId: string, templateId: string) {
  const { execSync } = await import('child_process')
  const { existsSync, readdirSync } = await import('fs')

  const namespace = getNamespace()
  const cacheDir = '/mnt/nfs-cache/cache'  // Shared NFS (template cache)
  const localBuildsDir = '/mnt/storage/builds'  // Local SSD (build snapshots)

  console.log('\n--- Pause Storage Paths ---')

  // Check template cache on NFS - MUST exist
  const templatePath = `${cacheDir}/${templateId}`
  const templateExists = existsSync(templatePath)
  console.log(`   Template cache: ${templatePath}/ [${templateExists ? 'EXISTS' : 'NOT FOUND'}]`)
  if (!templateExists) {
    throw new Error(`Template cache directory does not exist: ${templatePath}`)
  }
  const templateFiles = readdirSync(templatePath)
  console.log(`   Template files: ${templateFiles.join(', ')}`)

  // Check local builds on SSD - MUST exist (snapshots stored locally + uploaded to GCS)
  const localBuildsExists = existsSync(localBuildsDir)
  console.log(`   Local builds: ${localBuildsDir}/ [${localBuildsExists ? 'EXISTS' : 'NOT FOUND'}]`)
  if (!localBuildsExists) {
    throw new Error(`Local builds directory does not exist: ${localBuildsDir}`)
  }
  const localBuilds = readdirSync(localBuildsDir)
  console.log(`   Local builds count: ${localBuilds.length}`)
  if (localBuilds.length > 0) {
    console.log(`   Recent builds: ${localBuilds.slice(-3).join(', ')}`)
  }

  // Check GCS pause path - MUST exist
  const gcsPath = `gs://microsandbox/sandboxes/${namespace}/${sandboxId}/paused/`
  console.log(`   GCS pause path: ${gcsPath}`)
  let listOutput: string
  try {
    listOutput = execSync(`gsutil ls ${gcsPath}`, { encoding: 'utf8', timeout: 10_000 })
  } catch (e: any) {
    throw new Error(`GCS pause path does not exist: ${gcsPath} (${e.message})`)
  }
  const dirs = listOutput.trim().split('\n').filter(l => l.endsWith('/'))
  console.log(`   GCS snapshots: ${dirs.length} found [EXISTS]`)
  if (dirs.length === 0) {
    throw new Error(`No snapshots found in GCS pause path: ${gcsPath}`)
  }
  const latestDir = dirs[dirs.length - 1]
  console.log(`   Latest: ${latestDir}`)
  const filesOutput = execSync(`gsutil ls ${latestDir}`, { encoding: 'utf8', timeout: 10_000 })
  const files = filesOutput.trim().split('\n').map(f => f.split('/').pop())
  console.log(`   Pause files: ${files.join(', ')}`)
}

describe('Pause/Resume', () => {
  beforeAll(async () => {
    await ensureProdApiKey()
  }, 30_000)

  test('pause and resume sandbox with persistence', async () => {
    printTestHeader('Pause/Resume with Persistence Test')

    // 1. Create sandbox (use SMALL template for faster pause/resume)
    console.log('\n1. Creating sandbox...')
    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    const sandboxId = sandbox.sandboxId
    console.log(`   Sandbox created: ${sandboxId}`)
    expect(sandboxId).toBeDefined()

    try {
      // 2. Verify sandbox is working
      console.log('\n2. Verifying sandbox is working...')
      const result1 = await sandbox.commands.run('echo "before pause"', {
        timeoutMs: 30_000,
      })
      console.log(`   Output: ${result1.stdout.trim()}`)
      expect(result1.exitCode).toBe(0)
      expect(result1.stdout).toContain('before pause')

      // 3. Write file BEFORE pause (persistence test)
      console.log('\n3. Writing file before pause (persistence test)...')
      const testContent = `persisted-data-${Date.now()}`
      await sandbox.files.write('/home/user/persist-test.txt', testContent)
      console.log(`   Written: /home/user/persist-test.txt with content: "${testContent}"`)

      // Verify file exists before pause
      const contentBefore = await sandbox.files.read('/home/user/persist-test.txt')
      console.log(`   Verified: file exists before pause`)
      expect(contentBefore).toBe(testContent)

      // 4. Pause the sandbox
      console.log('\n4. Pausing sandbox (takes ~60s for snapshot + GCS upload)...')
      const pauseStartTime = Date.now()
      const paused = await sandbox.pause()
      const pauseDuration = ((Date.now() - pauseStartTime) / 1000).toFixed(1)
      console.log(`   Paused: ${paused} (took ${pauseDuration}s)`)
      expect(typeof paused).toBe('string')
      expect(paused).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

      // 5. Verify sandbox is paused (getInfo should show paused state)
      console.log('\n5. Checking sandbox state...')
      const info = await sandbox.getInfo()
      console.log(`   State: ${info.state}`)
      expect(info.state).toBe('paused')

      // 5b. Verify GCS upload
      console.log('\n5b. Verifying GCS upload...')
      const { execSync } = require('child_process')

      const namespace = getNamespace()
      const gcsPath = `gs://microsandbox/sandboxes/${namespace}/${sandboxId}/paused/`

      console.log(`   Checking GCS path: ${gcsPath}`)

      try {
        const listOutput = execSync(`gsutil ls ${gcsPath}`, { encoding: 'utf8', timeout: 10_000 })
        console.log(`   GCS directories found`)

        const snapshotDirs = listOutput.trim().split('\n').filter(l => l.endsWith('/'))
        expect(snapshotDirs.length).toBeGreaterThan(0)
        const latestSnapshotDir = snapshotDirs[snapshotDirs.length - 1]
        console.log(`   Latest snapshot: ${latestSnapshotDir}`)

        const filesOutput = execSync(`gsutil ls ${latestSnapshotDir}`, { encoding: 'utf8', timeout: 10_000 })
        const files = filesOutput.trim().split('\n')

        const hasSnapfile = files.some(f => f.includes('snapfile'))
        const hasMemfile = files.some(f => f.includes('memfile') && !f.includes('.header'))
        const hasMemfileHeader = files.some(f => f.includes('memfile.header'))
        const hasMetadata = files.some(f => f.includes('snapshot.json'))

        console.log(`   File verification: snapfile=${hasSnapfile}, memfile=${hasMemfile}, header=${hasMemfileHeader}, metadata=${hasMetadata}`)

        expect(hasSnapfile).toBe(true)
        expect(hasMemfile).toBe(true)
        expect(hasMemfileHeader).toBe(true)
        expect(hasMetadata).toBe(true)

        console.log(`   GCS upload verified!`)
      } catch (e: any) {
        throw new Error(`GCS verification failed: ${e.message}`)
      }

      // 5c. Assert pause storage paths
      await assertPauseStoragePaths(sandboxId, TEMPLATE_ID)

      // 5d. Verify NFS cache has memfile chunks (proves pre-warming)
      console.log('\n5d. Verifying NFS memfile chunks...')
      const { existsSync, readdirSync } = require('fs')
      const nfsCachePath = `/mnt/nfs-cache/cache/sandboxes/${getNamespace()}/${sandboxId}/paused/${paused}/memfile`
      const nfsCacheExists = existsSync(nfsCachePath)
      console.log(`   NFS memfile cache: ${nfsCachePath} [${nfsCacheExists ? 'EXISTS' : 'NOT FOUND'}]`)
      expect(nfsCacheExists).toBe(true)
      const memfileChunks = readdirSync(nfsCachePath).filter((f: string) => f.endsWith('.bin'))
      console.log(`   Memfile chunks cached: ${memfileChunks.length}`)
      expect(memfileChunks.length).toBeGreaterThan(0)

      // 6. Resume by reconnecting
      console.log('\n6. Resuming sandbox via Sandbox.connect()...')
      const resumeStartTime = Date.now()
      const resumedSandbox = await Sandbox.connect(sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
      const resumeDuration = ((Date.now() - resumeStartTime) / 1000).toFixed(1)
      console.log(`   Connected to: ${resumedSandbox.sandboxId} (took ${resumeDuration}s)`)
      expect(resumedSandbox.sandboxId).toBe(sandboxId)

      // 6b. Assert resume was snapshot restore (not cold start) by timing
      // Snapshot restore: ~1-2s, cold start: ~5-7s
      const resumeMs = Date.now() - resumeStartTime
      console.log(`   Resume duration: ${resumeMs}ms`)
      expect(resumeMs).toBeLessThan(5_000) // snapshot resume < 5s; cold start >= 5s

      // 7. Verify sandbox is running again
      console.log('\n7. Verifying sandbox is running...')
      const infoAfter = await resumedSandbox.getInfo()
      console.log(`   State: ${infoAfter.state}`)
      expect(infoAfter.state).toBe('running')

      // 8. Read file AFTER resume (persistence verification)
      console.log('\n8. Reading file after resume (persistence verification)...')
      const contentAfter = await resumedSandbox.files.read('/home/user/persist-test.txt')
      console.log(`   Content after resume: "${contentAfter}"`)
      expect(contentAfter).toBe(testContent)
      console.log(`   PERSISTENCE VERIFIED: File content survived pause/resume!`)

      // 9. Run command after resume
      console.log('\n9. Running command after resume...')
      const result2 = await resumedSandbox.commands.run('echo "after resume"', {
        timeoutMs: 30_000,
      })
      console.log(`   Output: ${result2.stdout.trim()}`)
      expect(result2.exitCode).toBe(0)
      expect(result2.stdout).toContain('after resume')

      console.log('\n=== Test Passed ===')

      // Cleanup
      await resumedSandbox.kill()
      console.log('Sandbox killed')
    } catch (error) {
      await Promise.allSettled([sandbox.kill()])
      throw error
    }
  }, 300_000)  // 5 minute timeout

  test('cold start sandbox with persistence', async () => {
    const NUM_CYCLES = 10
    const DATA_SIZE_KB = 512  // 512KB per cycle

    printTestHeader('Cold Start Multi-Cycle Persistence Test')
    console.log(`  Cycles: ${NUM_CYCLES}, Data per cycle: ${DATA_SIZE_KB}KB`)

    // Track all written files and their checksums
    const writtenFiles: Array<{ path: string; checksum: string; size: number }> = []

    // 1. Create sandbox
    console.log('\n1. Creating sandbox...')
    let currentSandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 60_000,
    })
    const sandboxId = currentSandbox.sandboxId
    console.log(`   Sandbox created: ${sandboxId}`)

    try {
      for (let cycle = 1; cycle <= NUM_CYCLES; cycle++) {
        console.log(`\n========== CYCLE ${cycle}/${NUM_CYCLES} ==========`)

        // --- Write data for this cycle ---
        const filePath = `/home/user/cycle_${cycle}.bin`
        console.log(`  [Write] ${filePath} (${DATA_SIZE_KB}KB)...`)

        // Generate random data and write to file using dd
        const writeCmd = `dd if=/dev/urandom of=${filePath} bs=1K count=${DATA_SIZE_KB} 2>/dev/null && md5sum ${filePath} | cut -d' ' -f1`
        const writeResult = await currentSandbox.commands.run(writeCmd, { timeoutMs: 30_000 })
        expect(writeResult.exitCode).toBe(0)

        const checksum = writeResult.stdout.trim()
        console.log(`  Written: checksum=${checksum}`)
        writtenFiles.push({ path: filePath, checksum, size: DATA_SIZE_KB * 1024 })

        // --- Verify ALL previous files still exist with correct checksums ---
        console.log(`  [Verify] Checking ${writtenFiles.length} files...`)
        for (const file of writtenFiles) {
          const verifyResult = await currentSandbox.commands.run(`md5sum ${file.path} | cut -d' ' -f1`, { timeoutMs: 10_000 })
          expect(verifyResult.exitCode).toBe(0)
          const actualChecksum = verifyResult.stdout.trim()
          expect(actualChecksum).toBe(file.checksum)
        }
        console.log(`  All ${writtenFiles.length} files verified`)

        // --- Pause ---
        console.log(`  [Pause]...`)
        const pauseStart = Date.now()
        const paused = await currentSandbox.pause()
        console.log(`  Paused (${((Date.now() - pauseStart) / 1000).toFixed(1)}s)`)
        expect(typeof paused).toBe('string')
        expect(paused).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

        // --- Cold Start ---
        console.log(`  [Cold Start]...`)
        const coldStartTime = Date.now()
        currentSandbox = await Sandbox.connect(sandboxId, {
          ...gatewayConfig,
          timeoutMs: 60_000,
          coldStart: true,
        })
        console.log(`  Cold started (${((Date.now() - coldStartTime) / 1000).toFixed(1)}s)`)

        // --- Verify ALL files after cold start ---
        console.log(`  [Post-Cold-Start Verify] Checking ${writtenFiles.length} files...`)
        for (const file of writtenFiles) {
          const verifyResult = await currentSandbox.commands.run(`md5sum ${file.path} | cut -d' ' -f1`, { timeoutMs: 10_000 })
          if (verifyResult.exitCode !== 0) {
            throw new Error(`File ${file.path} not found after cold start!`)
          }
          const actualChecksum = verifyResult.stdout.trim()
          if (actualChecksum !== file.checksum) {
            throw new Error(`Checksum mismatch for ${file.path}: expected ${file.checksum}, got ${actualChecksum}`)
          }
        }
        console.log(`  All ${writtenFiles.length} files verified after cold start`)
      }

      // Final summary
      const totalData = writtenFiles.reduce((sum, f) => sum + f.size, 0)
      console.log(`\n=== Test Passed ===`)
      console.log(`  ${NUM_CYCLES} cycles completed`)
      console.log(`  ${writtenFiles.length} files persisted (${(totalData / 1024).toFixed(0)}KB total)`)
      console.log(`  All checksums verified`)

      // Cleanup
      await currentSandbox.kill()
    } catch (error) {
      await Promise.allSettled([currentSandbox.kill()])
      throw error
    }
  }, 600_000)  // 10 minute timeout

  test('connect during pause returns 409 (Pausing state)', async () => {
    printTestHeader('Connect During Pause Test')

    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    try {
      // 1. Run a command to verify sandbox works
      console.log('\n1. Running command to verify sandbox works...')
      const result = await sandbox.commands.run('echo hello', { timeoutMs: 10_000 })
      console.log(`   Output: ${result.stdout.trim()}`)
      expect(result.exitCode).toBe(0)

      // 2. Start pause WITHOUT awaiting (fire and forget)
      console.log('\n2. Starting pause (not awaiting)...')
      const pausePromise = sandbox.pause()
      console.log('   Pause initiated')

      // 3. Wait a tiny bit for state to change to Pausing
      await new Promise(resolve => setTimeout(resolve, 100))

      // 4. Try to connect - should get 409 "pausing"
      console.log('\n3. Trying to connect while pausing (expect 409)...')
      try {
        const connected = await Sandbox.connect(sandbox.sandboxId, {
          ...gatewayConfig,
          timeoutMs: 10_000,
        })
        // If we get here, pause completed before connect - that's ok too
        console.log('   Connect succeeded (pause completed quickly)')
        await connected.kill()
      } catch (e: any) {
        console.log(`   Got error: ${e.message}`)
        if (e.message.includes('409') || e.message.includes('pausing')) {
          console.log('   Got expected 409 Pausing error!')
        } else {
          console.log('   Unexpected error type')
          throw e
        }
      }

      // 5. Wait for pause to complete
      console.log('\n4. Waiting for pause to complete...')
      await pausePromise
      console.log('   Pause completed')

      // 6. Now connect should work (sandbox is paused, will resume)
      console.log('\n5. Connecting after pause (should resume)...')
      const resumed = await Sandbox.connect(sandbox.sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
      console.log(`   Connected: ${resumed.sandboxId}`)

      // 7. Verify it works
      const result2 = await resumed.commands.run('echo after_resume', { timeoutMs: 10_000 })
      console.log(`   Output: ${result2.stdout.trim()}`)
      expect(result2.exitCode).toBe(0)

      await resumed.kill()
      console.log('\n=== Test Passed ===')
    } catch (error) {
      await Promise.allSettled([sandbox.kill()])
      throw error
    }
  }, 180_000)

  test('auto-pause on timeout - client specifies autoPause on each connect', async () => {
    printTestHeader('Auto-Pause Multiple Cycles Test')

    const TIMEOUT_SECONDS = 10
    const MAX_WAIT = 180  // Max 3 minutes for pause to complete

    // 1. Create sandbox with autoPause enabled and short timeout (10s)
    console.log(`\n1. Creating sandbox with autoPause=true and ${TIMEOUT_SECONDS}s timeout...`)
    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: TIMEOUT_SECONDS * 1000,
      autoPause: true,
    })
    const sandboxId = sandbox.sandboxId
    console.log(`   Sandbox created: ${sandboxId}`)
    expect(sandboxId).toBeDefined()

    // 2. Write first file for persistence verification
    console.log('\n2. Writing first file (data1.txt)...')
    const testContent1 = `autopause-data1-${Date.now()}`
    await sandbox.files.write('/home/user/data1.txt', testContent1)
    console.log(`   Written: /home/user/data1.txt`)
    const verifyData1 = await sandbox.files.read('/home/user/data1.txt')
    expect(verifyData1).toBe(testContent1)

    // 3. Wait for first auto-pause
    console.log(`\n3. Waiting up to ${MAX_WAIT}s for FIRST auto-pause...`)
    let pauseDetected = false
    for (let i = 1; i <= MAX_WAIT; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000))

      try {
        const info = await sandbox.getInfo()
        if (['pausing', 'paused'].includes(info.state)) {
          console.log(`   First auto-pause detected after ${i}s: ${info.state}`)
          pauseDetected = true

          if (info.state === 'pausing') {
            console.log(`   Waiting additional 30s for pause operation to complete...`)
            for (let j = 1; j <= 30; j++) {
              await new Promise(resolve => setTimeout(resolve, 1000))
              const checkInfo = await sandbox.getInfo()
              if (checkInfo.state === 'paused') {
                console.log(`   Pause completed after ${j}s`)
                break
              }
            }
          }
          break
        }
      } catch (e) {
        // Continue waiting
      }

      if (i % 10 === 0) {
        console.log(`   ${i}s elapsed...`)
      }
    }

    expect(pauseDetected).toBe(true)

    // 5. Resume sandbox (first resume)
    console.log('\n5. FIRST RESUME: Resuming sandbox with autoPause=true...')
    const resumed1 = await Sandbox.connect(sandboxId, {
      ...gatewayConfig,
      timeoutMs: TIMEOUT_SECONDS * 1000,
      autoPause: true,
    })
    console.log(`   Connected to: ${resumed1.sandboxId}`)
    expect(resumed1.sandboxId).toBe(sandboxId)

    // 6. Verify data1.txt still exists
    console.log('\n6. Verifying data1.txt survived first pause/resume...')
    const data1AfterResume = await resumed1.files.read('/home/user/data1.txt')
    console.log(`   Content: "${data1AfterResume}"`)
    expect(data1AfterResume).toBe(testContent1)

    // 7. Write second file
    console.log('\n7. Writing second file (data2.txt)...')
    const testContent2 = `autopause-data2-${Date.now()}`
    await resumed1.files.write('/home/user/data2.txt', testContent2)
    console.log(`   Written: /home/user/data2.txt`)

    // 8. Wait for SECOND auto-pause
    console.log(`\n8. Waiting up to ${MAX_WAIT}s for SECOND auto-pause...`)
    let secondPauseDetected = false
    for (let i = 1; i <= MAX_WAIT; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000))

      try {
        const info = await resumed1.getInfo()
        if (['pausing', 'paused'].includes(info.state)) {
          console.log(`   Second auto-pause detected after ${i}s: ${info.state}`)
          secondPauseDetected = true

          if (info.state === 'pausing') {
            for (let j = 1; j <= 30; j++) {
              await new Promise(resolve => setTimeout(resolve, 1000))
              const checkInfo = await resumed1.getInfo()
              if (checkInfo.state === 'paused') {
                console.log(`   Pause completed after ${j}s`)
                break
              }
            }
          }
          break
        }
      } catch (e) {
        // Continue waiting
      }

      if (i % 10 === 0) {
        console.log(`   ${i}s elapsed...`)
      }
    }

    expect(secondPauseDetected).toBe(true)

    // 10. Resume sandbox (second resume) - no autoPause
    console.log('\n10. SECOND RESUME: Resuming without autoPause...')
    const resumed2 = await Sandbox.connect(sandboxId, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`   Connected to: ${resumed2.sandboxId}`)

    // 11. Verify BOTH files still exist
    console.log('\n11. Verifying both files survived two pause/resume cycles...')
    const data1Final = await resumed2.files.read('/home/user/data1.txt')
    console.log(`   data1.txt: "${data1Final}"`)
    expect(data1Final).toBe(testContent1)

    const data2Final = await resumed2.files.read('/home/user/data2.txt')
    console.log(`   data2.txt: "${data2Final}"`)
    expect(data2Final).toBe(testContent2)

    // 12. Run command to verify sandbox is functional
    console.log('\n12. Running command to verify sandbox is functional...')
    const result = await resumed2.commands.run('echo "after two auto-pause cycles"', {
      timeoutMs: 30_000,
    })
    console.log(`   Output: ${result.stdout.trim()}`)
    expect(result.exitCode).toBe(0)

    console.log('\n=== Auto-Pause Multiple Cycles Test PASSED ===')

    // Cleanup
    await resumed2.kill()
    console.log('Sandbox killed')
  }, 300_000)

  test('multiple snapshot persistence - unique build_ids', async () => {
    printTestHeader('Multiple Snapshot Persistence Test')

    const { execSync } = require('child_process')

    // 1. Create sandbox
    console.log('\n1. Creating sandbox...')
    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    const sandboxId = sandbox.sandboxId
    console.log(`   Sandbox created: ${sandboxId}`)

    try {
      // 2. Write some data
      console.log('\n2. Writing test file...')
      await sandbox.files.write('/home/user/pause-test-1.txt', 'first-pause-data')
      console.log('   Written: /home/user/pause-test-1.txt')

      // 3. First pause
      console.log('\n3. First pause (takes ~60s)...')
      const pause1Start = Date.now()
      const paused1 = await sandbox.pause()
      const pause1Duration = ((Date.now() - pause1Start) / 1000).toFixed(1)
      console.log(`   First pause completed: ${paused1} (${pause1Duration}s)`)
      expect(typeof paused1).toBe('string')
      expect(paused1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

      // 4. Check DB for first snapshot
      console.log('\n4. Checking DB for first snapshot...')
      const count1 = execSync(
        `psql "${DB_URL}" -t -c "SELECT COUNT(*) FROM sandbox_snapshots WHERE sandbox_id = '${sandboxId}';"`,
        { encoding: 'utf8', timeout: 10_000 }
      ).trim()
      console.log(`   Snapshots after first pause: ${count1}`)
      expect(parseInt(count1)).toBe(1)

      const buildIds1 = execSync(
        `psql "${DB_URL}" -t -c "SELECT build_id FROM sandbox_snapshots WHERE sandbox_id = '${sandboxId}' ORDER BY created_at;"`,
        { encoding: 'utf8', timeout: 10_000 }
      ).trim().split('\n').map(s => s.trim()).filter(s => s)
      console.log(`   First build_id: ${buildIds1[0]}`)

      // 5. Resume sandbox
      console.log('\n5. Resuming sandbox...')
      const resumed = await Sandbox.connect(sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
      console.log(`   Sandbox resumed: ${resumed.sandboxId}`)

      // 6. Write more data
      console.log('\n6. Writing second test file...')
      await resumed.files.write('/home/user/pause-test-2.txt', 'second-pause-data')
      console.log('   Written: /home/user/pause-test-2.txt')

      // 7. Second pause
      console.log('\n7. Second pause (takes ~60s)...')
      const pause2Start = Date.now()
      const paused2 = await resumed.pause()
      const pause2Duration = ((Date.now() - pause2Start) / 1000).toFixed(1)
      console.log(`   Second pause completed: ${paused2} (${pause2Duration}s)`)
      expect(typeof paused2).toBe('string')
      expect(paused2).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

      // 8. Check DB for TWO snapshots with DIFFERENT build_ids
      console.log('\n8. Checking DB for two snapshots with unique build_ids...')
      const count2 = execSync(
        `psql "${DB_URL}" -t -c "SELECT COUNT(*) FROM sandbox_snapshots WHERE sandbox_id = '${sandboxId}';"`,
        { encoding: 'utf8', timeout: 10_000 }
      ).trim()
      console.log(`   Total snapshots after second pause: ${count2}`)
      expect(parseInt(count2)).toBe(2)

      const buildIds2 = execSync(
        `psql "${DB_URL}" -t -c "SELECT build_id FROM sandbox_snapshots WHERE sandbox_id = '${sandboxId}' ORDER BY created_at;"`,
        { encoding: 'utf8', timeout: 10_000 }
      ).trim().split('\n').map(s => s.trim()).filter(s => s)
      console.log(`   Build IDs: ${buildIds2.join(', ')}`)

      expect(buildIds2.length).toBe(2)
      expect(buildIds2[0]).not.toBe(buildIds2[1])
      expect(buildIds2[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      expect(buildIds2[1]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

      console.log(`\n   build_id fix verified:`)
      console.log(`     - Two snapshot records in DB`)
      console.log(`     - Each with unique UUID build_id`)
      console.log(`     - build_id[0]: ${buildIds2[0]}`)
      console.log(`     - build_id[1]: ${buildIds2[1]}`)

      // 8b. Verify local SSD cleanup: first build should be deleted after second pause
      // The optimization deletes previous builds from /mnt/storage/builds/ after pause
      // since they're already uploaded to GCS.
      // NOTE: Only run this assertion in dev environment (test runs on same machine as server)
      if (testEnv === 'dev') {
        console.log('\n8b. Verifying local SSD cleanup (previous build deleted)...')
        const { existsSync } = require('fs')
        const buildsDir = '/mnt/storage/builds'
        const firstBuildPath = `${buildsDir}/${buildIds2[0]}`
        const secondBuildPath = `${buildsDir}/${buildIds2[1]}`

        const firstBuildExists = existsSync(firstBuildPath)
        const secondBuildExists = existsSync(secondBuildPath)

        console.log(`   First build (${buildIds2[0]}): ${firstBuildExists ? 'EXISTS' : 'DELETED'}`)
        console.log(`   Second build (${buildIds2[1]}): ${secondBuildExists ? 'EXISTS' : 'DELETED'}`)

        // First build should be deleted (cleanup optimization)
        // Second build should exist (current pause)
        expect(firstBuildExists).toBe(false)
        expect(secondBuildExists).toBe(true)
        console.log('   Local SSD cleanup verified: previous build deleted, current build kept')
      } else {
        console.log('\n8b. Skipping local SSD cleanup verification (not in dev environment)')
      }

      // 9. Cleanup: Delete test snapshots from DB
      console.log('\n9. Cleaning up test snapshots...')
      execSync(
        `psql "${DB_URL}" -c "DELETE FROM sandbox_snapshots WHERE sandbox_id = '${sandboxId}';"`,
        { encoding: 'utf8', timeout: 10_000 }
      )
      console.log('   Snapshots deleted from DB')

      console.log('\n=== Test Passed ===')

    } catch (error) {
      try {
        execSync(
          `psql "${DB_URL}" -c "DELETE FROM sandbox_snapshots WHERE sandbox_id = '${sandboxId}';"`,
          { encoding: 'utf8', timeout: 10_000 }
        )
      } catch (e) {
        // Ignore cleanup errors
      }
      throw error
    }
  }, 300_000)
})
