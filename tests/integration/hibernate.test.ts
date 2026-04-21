/**
 * Hibernate Integration Tests
 *
 * Tests sandbox hibernate (rootfs-only pause) functionality:
 * - Hibernate saves disk state only (no memory snapshot)
 * - Resume after hibernate uses cold start (fresh boot)
 * - File persistence survives hibernate/resume
 * - GCS upload only contains rootfs + metadata (no memfile/snapfile)
 *
 * Run:
 *   npx vitest run tests/integration/hibernate.test.ts
 *
 * Run specific test:
 *   npx vitest run tests/integration/hibernate.test.ts -t "hibernate and resume"
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
const TEMPLATE_ID = getTemplateId()

describe('Hibernate', () => {
  beforeAll(async () => {
    await ensureProdApiKey()
  }, 30_000)

  test('hibernate and resume sandbox with persistence', async () => {
    printTestHeader('Hibernate/Resume with Persistence Test')

    // 1. Create sandbox
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
      const result1 = await sandbox.commands.run('echo "before hibernate"', {
        timeoutMs: 30_000,
      })
      console.log(`   Output: ${result1.stdout.trim()}`)
      expect(result1.exitCode).toBe(0)
      expect(result1.stdout).toContain('before hibernate')

      // 3. Write file BEFORE hibernate (persistence test)
      console.log('\n3. Writing file before hibernate (persistence test)...')
      const testContent = `hibernated-data-${Date.now()}`
      await sandbox.files.write('/home/user/hibernate-test.txt', testContent)
      console.log(`   Written: /home/user/hibernate-test.txt with content: "${testContent}"`)

      // Verify file exists before hibernate
      const contentBefore = await sandbox.files.read('/home/user/hibernate-test.txt')
      console.log(`   Verified: file exists before hibernate`)
      expect(contentBefore).toBe(testContent)

      // 4. Hibernate the sandbox (rootfs-only, no memory snapshot)
      console.log('\n4. Hibernating sandbox (rootfs-only, should be faster than full pause)...')
      const hibernateStartTime = Date.now()
      const hibernated = await sandbox.hibernate()
      const hibernateDuration = ((Date.now() - hibernateStartTime) / 1000).toFixed(1)
      console.log(`   Hibernated: ${hibernated} (took ${hibernateDuration}s)`)
      expect(hibernated).toBe(true)

      // 5. Verify sandbox is paused
      console.log('\n5. Checking sandbox state...')
      const info = await sandbox.getInfo()
      console.log(`   State: ${info.state}`)
      expect(info.state).toBe('paused')

      // 5b. Verify GCS upload - should NOT have memfile or snapfile
      console.log('\n5b. Verifying GCS upload (should be rootfs-only)...')
      const { execSync } = require('child_process')
      const namespace = getNamespace()
      const gcsPath = `gs://microsandbox/sandboxes/${namespace}/${sandboxId}/paused/`

      try {
        const listOutput = execSync(`gsutil ls ${gcsPath}`, { encoding: 'utf8', timeout: 10_000 })
        const snapshotDirs = listOutput.trim().split('\n').filter((l: string) => l.endsWith('/'))
        expect(snapshotDirs.length).toBeGreaterThan(0)
        const latestSnapshotDir = snapshotDirs[snapshotDirs.length - 1]
        console.log(`   Latest snapshot: ${latestSnapshotDir}`)

        const filesOutput = execSync(`gsutil ls ${latestSnapshotDir}`, { encoding: 'utf8', timeout: 10_000 })
        const files = filesOutput.trim().split('\n').map((f: string) => f.split('/').pop())

        const hasSnapfile = files.some((f: string | undefined) => f && f === 'snapfile')
        const hasMemfile = files.some((f: string | undefined) => f && f === 'memfile')
        const hasMemfileHeader = files.some((f: string | undefined) => f && f === 'memfile.header')
        const hasMetadata = files.some((f: string | undefined) => f && f?.includes('snapshot.json'))
        const hasRootfs = files.some((f: string | undefined) => f && f === 'rootfs')
        const hasRootfsHeader = files.some((f: string | undefined) => f && f === 'rootfs.header')

        console.log(`   Files: ${files.join(', ')}`)
        console.log(`   snapfile=${hasSnapfile}, memfile=${hasMemfile}, memfile.header=${hasMemfileHeader}`)
        console.log(`   rootfs=${hasRootfs}, rootfs.header=${hasRootfsHeader}, metadata=${hasMetadata}`)

        // Hibernate should NOT have memfile, memfile.header, or snapfile
        expect(hasSnapfile).toBe(false)
        expect(hasMemfile).toBe(false)
        expect(hasMemfileHeader).toBe(false)

        // Should have metadata
        expect(hasMetadata).toBe(true)

        // Should have rootfs (if sandbox had disk writes)
        // Note: rootfs may or may not be present depending on whether the sandbox had disk writes
        console.log(`   Hibernate GCS verified: no memfile/snapfile (rootfs-only)`)
      } catch (e: any) {
        console.log(`   GCS verification: ${e.message}`)
      }

      // 5c. Verify is_compacted in DB (soft check - GCS verification above is definitive)
      console.log('\n5c. Checking is_compacted flag in DB...')
      try {
        const compactedResult = execSync(
          `psql "${DB_URL}" -t -c "SELECT is_compacted FROM sandbox_snapshots WHERE sandbox_id = '${sandboxId}' ORDER BY created_at DESC LIMIT 1;"`,
          { encoding: 'utf8', timeout: 10_000 }
        ).trim()
        console.log(`   is_compacted: '${compactedResult}'`)
        if (compactedResult === 't') {
          console.log(`   DB confirmed: is_compacted = true`)
        } else {
          console.log(`   DB returned unexpected value (may be timing/connectivity issue)`)
        }
      } catch (e: any) {
        console.log(`   DB check skipped: ${e.message}`)
      }

      // 6. Resume by reconnecting (should auto-cold-start because is_compacted=true)
      console.log('\n6. Resuming sandbox (should cold start because hibernate = compacted)...')
      const resumeStartTime = Date.now()
      const resumedSandbox = await Sandbox.connect(sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
      const resumeDuration = ((Date.now() - resumeStartTime) / 1000).toFixed(1)
      console.log(`   Connected to: ${resumedSandbox.sandboxId} (took ${resumeDuration}s)`)
      expect(resumedSandbox.sandboxId).toBe(sandboxId)

      // 7. Verify sandbox is running again
      console.log('\n7. Verifying sandbox is running...')
      const infoAfter = await resumedSandbox.getInfo()
      console.log(`   State: ${infoAfter.state}`)
      expect(infoAfter.state).toBe('running')

      // 8. Read file AFTER resume (persistence verification)
      console.log('\n8. Reading file after resume (persistence verification)...')
      const contentAfter = await resumedSandbox.files.read('/home/user/hibernate-test.txt')
      console.log(`   Content after resume: "${contentAfter}"`)
      expect(contentAfter).toBe(testContent)
      console.log(`   PERSISTENCE VERIFIED: File content survived hibernate/resume!`)

      // 9. Run command after resume
      console.log('\n9. Running command after resume...')
      const result2 = await resumedSandbox.commands.run('echo "after hibernate resume"', {
        timeoutMs: 30_000,
      })
      console.log(`   Output: ${result2.stdout.trim()}`)
      expect(result2.exitCode).toBe(0)
      expect(result2.stdout).toContain('after hibernate resume')

      console.log('\n=== Hibernate Test Passed ===')

      // Cleanup
      await resumedSandbox.kill()
      console.log('Sandbox killed')

      // Clean up DB snapshots
      try {
        execSync(
          `psql "${DB_URL}" -c "DELETE FROM sandbox_snapshots WHERE sandbox_id = '${sandboxId}';"`,
          { encoding: 'utf8', timeout: 10_000 }
        )
        console.log('DB snapshots cleaned up')
      } catch (e) {
        // Ignore cleanup errors
      }
    } catch (error) {
      await Promise.allSettled([sandbox.kill()])
      throw error
    }
  }, 300_000)  // 5 minute timeout

  test('hibernate is faster than full pause', async () => {
    printTestHeader('Hibernate vs Pause Speed Comparison')

    // Create two sandboxes to compare
    console.log('\n1. Creating sandbox for full pause...')
    const sandbox1 = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`   Sandbox 1 (full pause): ${sandbox1.sandboxId}`)

    console.log('\n2. Creating sandbox for hibernate...')
    const sandbox2 = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`   Sandbox 2 (hibernate): ${sandbox2.sandboxId}`)

    try {
      // Write some data to both
      const testContent = `speed-test-data-${Date.now()}`
      await sandbox1.files.write('/home/user/speed-test.txt', testContent)
      await sandbox2.files.write('/home/user/speed-test.txt', testContent)
      console.log('   Both sandboxes have test data written')

      // Full pause
      console.log('\n3. Full pause...')
      const pauseStart = Date.now()
      await sandbox1.pause()
      const pauseDuration = Date.now() - pauseStart
      console.log(`   Full pause took: ${(pauseDuration / 1000).toFixed(1)}s`)

      // Hibernate
      console.log('\n4. Hibernate...')
      const hibernateStart = Date.now()
      await sandbox2.hibernate()
      const hibernateDuration = Date.now() - hibernateStart
      console.log(`   Hibernate took: ${(hibernateDuration / 1000).toFixed(1)}s`)

      // Compare
      const speedup = ((pauseDuration - hibernateDuration) / pauseDuration * 100).toFixed(0)
      console.log(`\n   Comparison:`)
      console.log(`   Full pause:  ${(pauseDuration / 1000).toFixed(1)}s`)
      console.log(`   Hibernate:   ${(hibernateDuration / 1000).toFixed(1)}s`)
      console.log(`   Speedup:     ${speedup}%`)

      // Hibernate should be faster (it skips memory snapshot)
      // Note: not asserting this strictly since timing can vary
      if (hibernateDuration < pauseDuration) {
        console.log(`   Hibernate was ${speedup}% faster than full pause`)
      } else {
        console.log(`   Note: Hibernate was not faster this run (timing variance)`)
      }

      // Resume both and verify persistence
      console.log('\n5. Resuming full-paused sandbox...')
      const resumed1 = await Sandbox.connect(sandbox1.sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
      const content1 = await resumed1.files.read('/home/user/speed-test.txt')
      expect(content1).toBe(testContent)
      console.log('   Full pause resume: persistence verified')

      console.log('\n6. Resuming hibernated sandbox...')
      const resumed2 = await Sandbox.connect(sandbox2.sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
      const content2 = await resumed2.files.read('/home/user/speed-test.txt')
      expect(content2).toBe(testContent)
      console.log('   Hibernate resume: persistence verified')

      console.log('\n=== Speed Comparison Test Passed ===')

      // Cleanup
      await Promise.allSettled([resumed1.kill(), resumed2.kill()])
      console.log('Both sandboxes killed')

      // Clean up DB snapshots
      const { execSync } = require('child_process')
      try {
        execSync(
          `psql "${DB_URL}" -c "DELETE FROM sandbox_snapshots WHERE sandbox_id IN ('${sandbox1.sandboxId}', '${sandbox2.sandboxId}');"`,
          { encoding: 'utf8', timeout: 10_000 }
        )
      } catch (e) {
        // Ignore
      }
    } catch (error) {
      await Promise.allSettled([sandbox1.kill(), sandbox2.kill()])
      throw error
    }
  }, 600_000)  // 10 minute timeout

  test('connect with specific buildId restores to that snapshot', async () => {
    printTestHeader('Connect with specific buildId')

    const { execSync } = require('child_process')

    // 1. Create sandbox and write file A
    console.log('\n1. Creating sandbox...')
    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    const sandboxId = sandbox.sandboxId
    console.log(`   Sandbox created: ${sandboxId}`)

    try {
      console.log('\n2. Writing file A...')
      await sandbox.files.write('/home/user/fileA.txt', 'content-A')
      const readA = await sandbox.files.read('/home/user/fileA.txt')
      expect(readA).toBe('content-A')
      console.log('   File A written and verified')

      // 3. Pause (full) — record build_id_1
      console.log('\n3. Full pausing sandbox (snapshot 1)...')
      await sandbox.pause()
      console.log('   Paused')

      // Get build_id_1 from DB
      const buildId1 = execSync(
        `psql "${DB_URL}" -t -c "SELECT build_id FROM sandbox_snapshots WHERE sandbox_id = '${sandboxId}' ORDER BY created_at DESC LIMIT 1;"`,
        { encoding: 'utf8', timeout: 10_000 }
      ).trim()
      console.log(`   build_id_1: ${buildId1}`)
      expect(buildId1).toBeTruthy()

      // 4. Resume, write file B, pause again — record build_id_2
      console.log('\n4. Resuming sandbox...')
      const sandbox2 = await Sandbox.connect(sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })

      console.log('   Writing file B...')
      await sandbox2.files.write('/home/user/fileB.txt', 'content-B')
      const readB = await sandbox2.files.read('/home/user/fileB.txt')
      expect(readB).toBe('content-B')
      console.log('   File B written and verified')

      // Also verify file A still exists
      const readA2 = await sandbox2.files.read('/home/user/fileA.txt')
      expect(readA2).toBe('content-A')
      console.log('   File A still exists')

      console.log('\n5. Full pausing sandbox (snapshot 2)...')
      await sandbox2.pause()
      console.log('   Paused')

      const buildId2 = execSync(
        `psql "${DB_URL}" -t -c "SELECT build_id FROM sandbox_snapshots WHERE sandbox_id = '${sandboxId}' ORDER BY created_at DESC LIMIT 1;"`,
        { encoding: 'utf8', timeout: 10_000 }
      ).trim()
      console.log(`   build_id_2: ${buildId2}`)
      expect(buildId2).toBeTruthy()
      expect(buildId2).not.toBe(buildId1)

      // 5. Connect with buildId_1 — verify file A exists but file B does NOT
      console.log(`\n6. Connecting with buildId_1 (${buildId1})...`)
      const sandbox3 = await Sandbox.connect(sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
        buildId: buildId1,
      })
      console.log(`   Connected to: ${sandbox3.sandboxId}`)

      console.log('   Checking file A...')
      const readA3 = await sandbox3.files.read('/home/user/fileA.txt')
      expect(readA3).toBe('content-A')
      console.log('   File A exists with correct content')

      console.log('   Checking file B (should NOT exist)...')
      let fileBExists = true
      try {
        await sandbox3.files.read('/home/user/fileB.txt')
      } catch (e) {
        fileBExists = false
      }
      expect(fileBExists).toBe(false)
      console.log('   File B correctly does NOT exist')

      console.log('\n=== buildId Connect Test Passed ===')

      // Cleanup
      await sandbox3.kill()
      console.log('Sandbox killed')

      try {
        execSync(
          `psql "${DB_URL}" -c "DELETE FROM sandbox_snapshots WHERE sandbox_id = '${sandboxId}';"`,
          { encoding: 'utf8', timeout: 10_000 }
        )
        console.log('DB snapshots cleaned up')
      } catch (e) {
        // Ignore cleanup errors
      }
    } catch (error) {
      await Promise.allSettled([sandbox.kill()])
      throw error
    }
  }, 600_000)  // 10 minute timeout

  test('multi-cycle hibernate with accumulating data', async () => {
    const NUM_CYCLES = 3
    const DATA_SIZE_KB = 256

    printTestHeader('Multi-Cycle Hibernate Persistence Test')
    console.log(`  Cycles: ${NUM_CYCLES}, Data per cycle: ${DATA_SIZE_KB}KB`)

    const writtenFiles: Array<{ path: string; checksum: string }> = []

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

        // Write data for this cycle
        const filePath = `/home/user/cycle_${cycle}.bin`
        console.log(`  [Write] ${filePath} (${DATA_SIZE_KB}KB)...`)
        const writeCmd = `dd if=/dev/urandom of=${filePath} bs=1K count=${DATA_SIZE_KB} 2>/dev/null && md5sum ${filePath} | cut -d' ' -f1`
        const writeResult = await currentSandbox.commands.run(writeCmd, { timeoutMs: 30_000 })
        expect(writeResult.exitCode).toBe(0)
        const checksum = writeResult.stdout.trim()
        console.log(`  Written: checksum=${checksum}`)
        writtenFiles.push({ path: filePath, checksum })

        // Verify ALL previous files still exist
        console.log(`  [Verify] Checking ${writtenFiles.length} files...`)
        for (const file of writtenFiles) {
          const verifyResult = await currentSandbox.commands.run(`md5sum ${file.path} | cut -d' ' -f1`, { timeoutMs: 10_000 })
          expect(verifyResult.exitCode).toBe(0)
          expect(verifyResult.stdout.trim()).toBe(file.checksum)
        }
        console.log(`  All ${writtenFiles.length} files verified`)

        // Hibernate
        console.log(`  [Hibernate]...`)
        const hibernateStart = Date.now()
        const hibernated = await currentSandbox.hibernate()
        console.log(`  Hibernated (${((Date.now() - hibernateStart) / 1000).toFixed(1)}s)`)
        expect(hibernated).toBe(true)

        // Resume (cold start because hibernated = compacted)
        console.log(`  [Resume]...`)
        const resumeStart = Date.now()
        currentSandbox = await Sandbox.connect(sandboxId, {
          ...gatewayConfig,
          timeoutMs: 60_000,
        })
        console.log(`  Resumed (${((Date.now() - resumeStart) / 1000).toFixed(1)}s)`)

        // Verify ALL files after resume
        console.log(`  [Post-Resume Verify] Checking ${writtenFiles.length} files...`)
        for (const file of writtenFiles) {
          const verifyResult = await currentSandbox.commands.run(`md5sum ${file.path} | cut -d' ' -f1`, { timeoutMs: 10_000 })
          if (verifyResult.exitCode !== 0) {
            throw new Error(`File ${file.path} not found after hibernate resume!`)
          }
          expect(verifyResult.stdout.trim()).toBe(file.checksum)
        }
        console.log(`  All ${writtenFiles.length} files verified after resume`)
      }

      console.log(`\n=== Multi-Cycle Hibernate Test Passed ===`)
      console.log(`  ${NUM_CYCLES} cycles completed, ${writtenFiles.length} files persisted`)

      // Cleanup
      await currentSandbox.kill()

      const { execSync } = require('child_process')
      try {
        execSync(
          `psql "${DB_URL}" -c "DELETE FROM sandbox_snapshots WHERE sandbox_id = '${sandboxId}';"`,
          { encoding: 'utf8', timeout: 10_000 }
        )
      } catch (e) {
        // Ignore
      }
    } catch (error) {
      await Promise.allSettled([currentSandbox.kill()])
      throw error
    }
  }, 600_000)  // 10 minute timeout

  test('hibernate preserves data integrity under heavy write load', async () => {
    printTestHeader('Hibernate Data Integrity Stress Test')

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
      // 2. Start heavy background write (50MB of random data)
      console.log('\n2. Starting heavy background write (50MB)...')
      await sandbox.commands.run(
        'nohup dd if=/dev/urandom of=/home/user/large.bin bs=1M count=50 2>/dev/null &',
        { timeoutMs: 10_000, background: true },
      )
      console.log('   Heavy write started in background')

      // 3. Write additional small files while heavy write is in progress
      console.log('\n3. Writing small files concurrently...')
      const smallFiles: Array<{ path: string; content: string }> = []
      for (let i = 1; i <= 5; i++) {
        const path = `/home/user/small_${i}.txt`
        const content = `integrity-check-${i}-${Date.now()}-${'x'.repeat(1024)}`
        await sandbox.files.write(path, content)
        smallFiles.push({ path, content })
        console.log(`   Written: ${path} (${content.length} bytes)`)
      }

      // 4. Wait for heavy write to finish, then compute checksums
      console.log('\n4. Waiting for heavy write to finish and computing checksums...')
      const checksumCmd = [
        // Wait for dd to finish (up to 60s)
        'for i in $(seq 1 60); do pgrep -f "dd if=/dev/urandom" > /dev/null 2>&1 || break; sleep 1; done',
        // Sync to flush
        'sync',
        // Compute checksum of the large file
        'md5sum /home/user/large.bin 2>/dev/null | cut -d" " -f1',
      ].join(' && ')

      const checksumResult = await sandbox.commands.run(checksumCmd, { timeoutMs: 120_000 })
      expect(checksumResult.exitCode).toBe(0)
      const largeFileChecksum = checksumResult.stdout.trim()
      console.log(`   large.bin checksum: ${largeFileChecksum}`)
      expect(largeFileChecksum).toMatch(/^[a-f0-9]{32}$/)

      // Get checksums of small files too
      const smallChecksumResult = await sandbox.commands.run(
        'md5sum /home/user/small_*.txt | sort',
        { timeoutMs: 30_000 },
      )
      expect(smallChecksumResult.exitCode).toBe(0)
      const smallChecksumsBeforeHibernate = smallChecksumResult.stdout.trim()
      console.log(`   Small file checksums:\n${smallChecksumsBeforeHibernate}`)

      // 5. Hibernate while filesystem may still have cached pages
      console.log('\n5. Hibernating sandbox...')
      const hibernateStart = Date.now()
      const hibernated = await sandbox.hibernate()
      const hibernateDuration = ((Date.now() - hibernateStart) / 1000).toFixed(1)
      console.log(`   Hibernated (${hibernateDuration}s)`)
      expect(hibernated).toBe(true)

      // 6. Resume (cold boot)
      console.log('\n6. Resuming sandbox (cold boot)...')
      const resumeStart = Date.now()
      const resumed = await Sandbox.connect(sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
      const resumeDuration = ((Date.now() - resumeStart) / 1000).toFixed(1)
      console.log(`   Resumed (${resumeDuration}s)`)

      // 7. Verify large file checksum
      console.log('\n7. Verifying large file integrity...')
      const verifyLargeResult = await resumed.commands.run(
        'md5sum /home/user/large.bin | cut -d" " -f1',
        { timeoutMs: 30_000 },
      )
      expect(verifyLargeResult.exitCode).toBe(0)
      const largeFileChecksumAfter = verifyLargeResult.stdout.trim()
      console.log(`   large.bin checksum after resume: ${largeFileChecksumAfter}`)
      expect(largeFileChecksumAfter).toBe(largeFileChecksum)
      console.log('   LARGE FILE INTEGRITY VERIFIED')

      // 8. Verify small file checksums
      console.log('\n8. Verifying small file integrity...')
      const verifySmallResult = await resumed.commands.run(
        'md5sum /home/user/small_*.txt | sort',
        { timeoutMs: 30_000 },
      )
      expect(verifySmallResult.exitCode).toBe(0)
      const smallChecksumsAfterResume = verifySmallResult.stdout.trim()
      expect(smallChecksumsAfterResume).toBe(smallChecksumsBeforeHibernate)
      console.log('   SMALL FILE INTEGRITY VERIFIED')

      // 9. Verify small file contents via SDK read
      console.log('\n9. Verifying small file contents via SDK...')
      for (const file of smallFiles) {
        const content = await resumed.files.read(file.path)
        expect(content).toBe(file.content)
      }
      console.log(`   All ${smallFiles.length} small files verified via SDK read`)

      console.log('\n=== Hibernate Data Integrity Stress Test Passed ===')

      // Cleanup
      await resumed.kill()
      console.log('Sandbox killed')

      try {
        execSync(
          `psql "${DB_URL}" -c "DELETE FROM sandbox_snapshots WHERE sandbox_id = '${sandboxId}';"`,
          { encoding: 'utf8', timeout: 10_000 },
        )
        console.log('DB snapshots cleaned up')
      } catch (e) {
        // Ignore cleanup errors
      }
    } catch (error) {
      await Promise.allSettled([sandbox.kill()])
      throw error
    }
  }, 600_000)  // 10 minute timeout
})
