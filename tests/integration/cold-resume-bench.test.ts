/**
 * Cold Resume Benchmark
 *
 * Measures the latency breakdown of resuming a paused sandbox when all local
 * caches are cleared (forcing GCS-only fetch). This tests the real production
 * path: gateway → orchestrator → GCS lazy load → VM boot.
 *
 * ## What it measures
 *
 * 1. Pause time (snapshot + GCS upload)
 * 2. Resume time with NO local cache (everything from GCS):
 *    - Total resume (Sandbox.connect)
 *    - First command after resume
 * 3. Resume time with WARM cache (NFS populated from first resume):
 *    - Total resume (Sandbox.connect)
 *    - First command after resume
 *
 * ## Running
 *
 * ```bash
 * # Small template (512MB, default)
 * npx vitest run tests/integration/cold-resume-bench.test.ts
 *
 * # Large template (4GB, production-like, ~30s resume)
 * TEST_TEMPLATE=large npx vitest run tests/integration/cold-resume-bench.test.ts
 * ```
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { Sandbox } from '../../src'
import {
  getTemplateId,
  getGatewayConfig,
  getEnvironment,
  getDatabaseUrl,
  ensureProdApiKey,
  getNamespace,
} from './common'
import { execSync } from 'child_process'
import { existsSync, readdirSync } from 'fs'

const gatewayConfig = getGatewayConfig()
const TEMPLATE_ID = getTemplateId()
const DB_URL = getDatabaseUrl()

/** Time an async operation, return [result, durationMs] */
async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = Date.now()
  const result = await fn()
  return [result, Date.now() - start]
}

/** Format milliseconds as seconds with 1 decimal */
function secs(ms: number): string {
  return (ms / 1000).toFixed(1)
}

/** Get build IDs for a sandbox from GCS (source of truth) */
function getBuildIdsFromGcs(sandboxId: string): string[] {
  const namespace = getNamespace()
  const gcsPath = `gs://microsandbox/sandboxes/${namespace}/${sandboxId}/paused/`
  try {
    const output = execSync(`gsutil ls ${gcsPath}`, { encoding: 'utf8', timeout: 15_000 })
    return output.trim().split('\n')
      .filter(l => l.endsWith('/'))
      .map(l => l.replace(gcsPath, '').replace(/\/$/, ''))
      .filter(s => s)
  } catch {
    return []
  }
}

/** Delete all local SSD build dirs for a sandbox (requires sudo) */
function deleteLocalBuilds(sandboxId: string): string[] {
  const buildsDir = '/mnt/storage/builds'
  const buildIds = getBuildIdsFromGcs(sandboxId)
  console.log(`  GCS has ${buildIds.length} build_id(s): ${buildIds.join(', ')}`)

  const deleted: string[] = []
  for (const buildId of buildIds) {
    // Local SSD builds may have a suffix after the build_id (e.g. {build_id}-{uuid8})
    try {
      const matches = execSync(
        `sudo ls "${buildsDir}" | grep "^${buildId}"`,
        { encoding: 'utf8', timeout: 5_000 }
      ).trim().split('\n').filter(s => s)

      for (const entry of matches) {
        const fullPath = `${buildsDir}/${entry}`
        execSync(`sudo rm -rf "${fullPath}"`)
        deleted.push(entry)
      }
    } catch { /* no matches */ }
  }

  // Also delete the base template build dir (template chunks use this for mmap cache)
  try {
    const matches = execSync(
      `sudo ls "${buildsDir}" | grep "^${TEMPLATE_ID}"`,
      { encoding: 'utf8', timeout: 5_000 }
    ).trim().split('\n').filter(s => s)

    for (const entry of matches) {
      const fullPath = `${buildsDir}/${entry}`
      execSync(`sudo rm -rf "${fullPath}"`)
      deleted.push(entry)
    }
  } catch { /* no matches */ }

  return deleted
}

/** Delete NFS chunk cache for a sandbox's paused snapshots (requires sudo) */
function deleteNfsChunkCache(sandboxId: string): string[] {
  const namespace = getNamespace()
  const nfsCacheBase = `/mnt/nfs-cache/cache/sandboxes/${namespace}/${sandboxId}/paused`
  const deleted: string[] = []

  try {
    // Use sudo ls since NFS dirs are root-owned
    const entries = execSync(
      `sudo ls "${nfsCacheBase}" 2>/dev/null`,
      { encoding: 'utf8', timeout: 5_000 }
    ).trim().split('\n').filter(s => s)

    for (const entry of entries) {
      const fullPath = `${nfsCacheBase}/${entry}`
      execSync(`sudo rm -rf "${fullPath}"`)
      deleted.push(entry)
    }
  } catch { /* dir doesn't exist or empty */ }

  return deleted
}

/** Delete NFS chunk cache for the base template (requires sudo).
 *  Only deletes chunk-related files: memfile/, rootfs/ (chunk dirs),
 *  memfile.cache, rootfs.cache (BlockCache mmap files).
 *  Preserves: snapfile, metadata.json, headers (needed for template setup).
 */
function deleteNfsTemplateCache(templateId: string): string[] {
  const nfsCacheBase = `/mnt/nfs-cache/cache/${templateId}`
  const deleted: string[] = []
  // Only delete chunk cache files, not snapfile/metadata/headers
  const toDelete = ['memfile', 'rootfs', 'memfile.cache', 'rootfs.cache']

  for (const entry of toDelete) {
    const fullPath = `${nfsCacheBase}/${entry}`
    try {
      execSync(`sudo rm -rf "${fullPath}" 2>/dev/null`, { encoding: 'utf8', timeout: 10_000 })
      deleted.push(entry)
    } catch { /* doesn't exist */ }
  }

  return deleted
}

describe('Cold Resume Benchmark', () => {
  beforeAll(async () => {
    await ensureProdApiKey()
  }, 30_000)

  test('measure cold resume latency breakdown', async () => {
    const template = { id: getTemplateId(), name: "default" }
    const env = getEnvironment()

    console.log(`\n${'='.repeat(60)}`)
    console.log(`  Cold Resume Benchmark`)
    console.log(`  Template: ${template.name} (${template.memory})`)
    console.log(`  Environment: ${env} (${gatewayConfig.apiUrl})`)
    console.log(`${'='.repeat(60)}\n`)

    const timings: { phase: string; ms: number }[] = []

    // ================================================================
    // Phase 1: Create sandbox
    // ================================================================
    console.log('--- Phase 1: Create sandbox ---')
    const [sandbox, createMs] = await timed(() =>
      Sandbox.create(TEMPLATE_ID, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
    )
    const sandboxId = sandbox.sandboxId
    timings.push({ phase: 'Create sandbox', ms: createMs })
    console.log(`  Created: ${sandboxId} (${secs(createMs)}s)`)

    try {
      // ================================================================
      // Phase 2: Do work (write data, trigger rootfs + memfile changes)
      // ================================================================
      console.log('\n--- Phase 2: Do work in sandbox ---')

      // Write random data to trigger rootfs dirty blocks
      const [, writeMs] = await timed(async () => {
        await sandbox.commands.run(
          'dd if=/dev/urandom of=/home/user/bench.bin bs=1M count=10 2>/dev/null',
          { timeoutMs: 30_000 }
        )
      })
      console.log(`  Wrote 10MB random data (${secs(writeMs)}s)`)

      // Create marker for verification
      const marker = `BENCH_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
      await sandbox.files.write('/home/user/marker.txt', marker)
      console.log(`  Marker: ${marker}`)

      // Sync filesystem
      await sandbox.commands.run('sync', { timeoutMs: 10_000 })

      // ================================================================
      // Phase 3: Pause
      // ================================================================
      console.log('\n--- Phase 3: Pause ---')
      const [, pauseMs] = await timed(() => sandbox.pause())
      timings.push({ phase: 'Pause', ms: pauseMs })
      console.log(`  Paused (${secs(pauseMs)}s)`)

      // Wait for GCS upload to complete
      const info = await sandbox.getInfo()
      expect(info.state).toBe('paused')
      console.log(`  State: ${info.state}`)

      // Verify GCS upload
      const gcsPath = `gs://microsandbox/sandboxes/${getNamespace()}/${sandboxId}/paused/`
      let gcsVerified = false
      for (let i = 0; i < 30; i++) {
        try {
          const output = execSync(`gsutil ls ${gcsPath}`, { encoding: 'utf8', timeout: 10_000 })
          const dirs = output.trim().split('\n').filter(l => l.endsWith('/'))
          if (dirs.length > 0) {
            // Verify files exist in latest snapshot
            const latest = dirs[dirs.length - 1]
            const files = execSync(`gsutil ls ${latest}`, { encoding: 'utf8', timeout: 10_000 })
            if (files.includes('memfile') && files.includes('snapfile')) {
              console.log(`  GCS upload verified: ${dirs.length} snapshot(s)`)
              gcsVerified = true
              break
            }
          }
        } catch { /* retry */ }
        await new Promise(r => setTimeout(r, 2000))
      }
      expect(gcsVerified).toBe(true)

      // ================================================================
      // Phase 4: Delete all local caches (force GCS-only resume)
      // ================================================================
      console.log('\n--- Phase 4: Delete local caches ---')

      const deletedLocal = deleteLocalBuilds(sandboxId)
      console.log(`  Local SSD: deleted ${deletedLocal.length} build dir(s)`)
      for (const d of deletedLocal) console.log(`    - ${d}`)

      const deletedNfs = deleteNfsChunkCache(sandboxId)
      console.log(`  NFS sandbox chunks: deleted ${deletedNfs.length} snapshot dir(s)`)
      for (const d of deletedNfs) console.log(`    - ${d}`)

      // Also delete the base template NFS cache (template chunks are cached on NFS too)
      const deletedTemplateNfs = deleteNfsTemplateCache(TEMPLATE_ID)
      console.log(`  NFS template chunks: deleted ${deletedTemplateNfs.length} dir(s)`)
      for (const d of deletedTemplateNfs) console.log(`    - ${d}`)

      // ================================================================
      // Phase 5: COLD resume (everything from GCS)
      // ================================================================
      console.log('\n--- Phase 5: Cold resume (GCS only, no local cache) ---')

      const [coldSandbox, coldResumeMs] = await timed(() =>
        Sandbox.connect(sandboxId, {
          ...gatewayConfig,
          timeoutMs: 300_000,
        })
      )
      timings.push({ phase: 'Cold resume', ms: coldResumeMs })
      console.log(`  Resumed: ${coldSandbox.sandboxId} (${secs(coldResumeMs)}s)`)

      // First command after cold resume
      const [cmdResult, firstCmdMs] = await timed(() =>
        coldSandbox.commands.run('cat /home/user/marker.txt', { timeoutMs: 30_000 })
      )
      timings.push({ phase: 'First cmd (cold)', ms: firstCmdMs })
      console.log(`  First command: ${secs(firstCmdMs)}s`)
      expect(cmdResult.stdout.trim()).toBe(marker)
      console.log(`  Marker verified`)

      // ================================================================
      // Phase 6: Pause again (NFS is now populated from cold resume)
      // ================================================================
      console.log('\n--- Phase 6: Pause (NFS now populated from cold resume) ---')
      const [, pause2Ms] = await timed(() => coldSandbox.pause())
      timings.push({ phase: 'Pause 2', ms: pause2Ms })
      console.log(`  Paused (${secs(pause2Ms)}s)`)

      // Delete local SSD only — NFS chunks remain from cold resume GCS downloads
      console.log('\n--- Phase 7: Delete local SSD only (keep NFS from cold) ---')
      const deletedLocal2 = deleteLocalBuilds(sandboxId)
      console.log(`  Local SSD: deleted ${deletedLocal2.length} build dir(s)`)

      // ================================================================
      // Phase 8: NFS resume (NFS cached from cold resume, no local SSD)
      // ================================================================
      console.log('\n--- Phase 8: NFS resume (chunks cached on NFS from cold resume) ---')

      const [nfsSandbox, nfsResumeMs] = await timed(() =>
        Sandbox.connect(sandboxId, {
          ...gatewayConfig,
          timeoutMs: 300_000,
        })
      )
      timings.push({ phase: 'NFS resume', ms: nfsResumeMs })
      console.log(`  Resumed: ${nfsSandbox.sandboxId} (${secs(nfsResumeMs)}s)`)

      // First command after NFS resume
      const [cmdResult2, nfsCmdMs] = await timed(() =>
        nfsSandbox.commands.run('cat /home/user/marker.txt', { timeoutMs: 30_000 })
      )
      timings.push({ phase: 'First cmd (NFS)', ms: nfsCmdMs })
      console.log(`  First command: ${secs(nfsCmdMs)}s`)
      expect(cmdResult2.stdout.trim()).toBe(marker)
      console.log(`  Marker verified`)

      // ================================================================
      // Cleanup
      // ================================================================
      console.log('\n--- Cleanup ---')
      await nfsSandbox.kill()
      console.log('  Sandbox killed')

      // Clean up DB snapshots
      try {
        execSync(
          `psql "${DB_URL}" -c "DELETE FROM sandbox_snapshots WHERE sandbox_id = '${sandboxId}';"`,
          { encoding: 'utf8', timeout: 10_000 }
        )
        console.log('  Snapshots deleted from DB')
      } catch { /* best effort */ }

      // ================================================================
      // Timing Summary
      // ================================================================
      console.log(`\n${'='.repeat(60)}`)
      console.log(`  COLD RESUME BENCHMARK RESULTS`)
      console.log(`  Template: ${template.name} (${template.memory})`)
      console.log(`${'='.repeat(60)}`)
      console.log()

      const maxPhaseLen = Math.max(...timings.map(t => t.phase.length))
      for (const t of timings) {
        const bar = '█'.repeat(Math.ceil(t.ms / 1000))
        console.log(`  ${t.phase.padEnd(maxPhaseLen)}  ${secs(t.ms).padStart(6)}s  ${bar}`)
      }

      const coldTotal = timings
        .filter(t => t.phase === 'Cold resume' || t.phase === 'First cmd (cold)')
        .reduce((sum, t) => sum + t.ms, 0)
      const nfsTotal = timings
        .filter(t => t.phase === 'NFS resume' || t.phase === 'First cmd (NFS)')
        .reduce((sum, t) => sum + t.ms, 0)

      console.log()
      console.log(`  ${'─'.repeat(maxPhaseLen + 20)}`)
      console.log(`  ${'Cold total'.padEnd(maxPhaseLen)}  ${secs(coldTotal).padStart(6)}s  (GCS only, no cache)`)
      console.log(`  ${'NFS total'.padEnd(maxPhaseLen)}  ${secs(nfsTotal).padStart(6)}s  (NFS cached from cold)`)
      console.log()
      console.log(`  ${'Cold → NFS speedup'.padEnd(maxPhaseLen)}  ${(coldTotal / nfsTotal).toFixed(1).padStart(6)}x`)
      console.log()
      console.log(`${'='.repeat(60)}`)
      console.log(`  BENCHMARK PASSED`)
      console.log(`${'='.repeat(60)}\n`)

    } catch (error) {
      await Promise.allSettled([sandbox.kill()])
      throw error
    }
  }, 600_000) // 10 minute timeout
})
