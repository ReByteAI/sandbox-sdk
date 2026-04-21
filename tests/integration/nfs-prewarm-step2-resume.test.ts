/**
 * NFS Pre-warm Test — Step 2: Resume after server restart
 *
 * This is the second half of a two-step test. It resumes a sandbox that was
 * paused in Step 1, AFTER a full server restart. This proves that NFS
 * pre-warming works — the only surviving cache is NFS (all in-memory state
 * is gone after restart).
 *
 * ## Usage
 * ```bash
 * # Option A: Use env vars from step 1 output
 * SANDBOX_ID=<id> MARKER=<marker> npx vitest run tests/integration/nfs-prewarm-step2-resume.test.ts
 *
 * # Option B: Auto-read from state file (written by step 1)
 * npx vitest run tests/integration/nfs-prewarm-step2-resume.test.ts
 * ```
 */

import { describe, test, expect } from 'vitest'
import { Sandbox } from '../../src'
import { getGatewayConfig, getEnvironment, getDatabaseUrl } from './common'
import { readFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'

const gatewayConfig = getGatewayConfig()
const DB_URL = getDatabaseUrl()

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = Date.now()
  const result = await fn()
  return [result, Date.now() - start]
}

function secs(ms: number): string {
  return (ms / 1000).toFixed(1)
}

/** Load test state from step 1 */
function loadState(): { sandboxId: string; marker: string; buildId: string; memfileChunks: number; rootfsChunks: number; template: string } {
  // Try env vars first
  if (process.env.SANDBOX_ID) {
    return {
      sandboxId: process.env.SANDBOX_ID,
      marker: process.env.MARKER || '',
      buildId: process.env.BUILD_ID || 'unknown',
      memfileChunks: 0,
      rootfsChunks: 0,
      template: process.env.TEST_TEMPLATE || 'unknown',
    }
  }

  // Fall back to state file
  const stateFile = '/tmp/nfs-prewarm-test-state.json'
  if (!existsSync(stateFile)) {
    throw new Error(
      'No sandbox ID provided. Either:\n' +
      '  - Set SANDBOX_ID env var: SANDBOX_ID=xxx npx vitest run ...\n' +
      '  - Run step 1 first: npx vitest run tests/integration/nfs-prewarm-step1-pause.test.ts'
    )
  }

  return JSON.parse(readFileSync(stateFile, 'utf8'))
}

describe('NFS Pre-warm Step 2: Resume', () => {
  test('resume paused sandbox after server restart', async () => {
    const state = loadState()
    const env = getEnvironment()

    console.log(`\n${'='.repeat(60)}`)
    console.log(`  NFS Pre-warm Test — Step 2: Resume`)
    console.log(`  Sandbox: ${state.sandboxId}`)
    console.log(`  Template: ${state.template}`)
    console.log(`  NFS chunks from step 1: ${state.memfileChunks} memfile + ${state.rootfsChunks} rootfs`)
    console.log(`  Environment: ${env} (${gatewayConfig.apiUrl})`)
    console.log(`${'='.repeat(60)}\n`)

    // ================================================================
    // Phase 1: Resume the paused sandbox
    // ================================================================
    console.log('--- Phase 1: Resume sandbox (NFS pre-warmed, server freshly restarted) ---')

    const [sandbox, resumeMs] = await timed(() =>
      Sandbox.connect(state.sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
    )
    console.log(`  Resumed: ${sandbox.sandboxId} (${secs(resumeMs)}s)`)

    // ================================================================
    // Phase 2: First command
    // ================================================================
    console.log('\n--- Phase 2: First command after resume ---')

    const [cmdResult, firstCmdMs] = await timed(() =>
      sandbox.commands.run('cat /home/user/marker.txt', { timeoutMs: 30_000 })
    )
    console.log(`  First command: ${secs(firstCmdMs)}s`)

    if (state.marker) {
      expect(cmdResult.stdout.trim()).toBe(state.marker)
      console.log(`  Marker verified: ${state.marker}`)
    } else {
      console.log(`  Marker content: ${cmdResult.stdout.trim()}`)
      console.log(`  (no marker to verify — MARKER env var not set)`)
    }

    // ================================================================
    // Phase 3: Second command (measures steady-state)
    // ================================================================
    console.log('\n--- Phase 3: Second command (steady state) ---')

    const [cmdResult2, secondCmdMs] = await timed(() =>
      sandbox.commands.run('echo hello', { timeoutMs: 10_000 })
    )
    console.log(`  Second command: ${secs(secondCmdMs)}s`)
    expect(cmdResult2.stdout.trim()).toBe('hello')

    // ================================================================
    // Cleanup
    // ================================================================
    console.log('\n--- Cleanup ---')
    await sandbox.kill()
    console.log('  Sandbox killed')

    try {
      execSync(
        `psql "${DB_URL}" -c "DELETE FROM sandbox_snapshots WHERE sandbox_id = '${state.sandboxId}';"`,
        { encoding: 'utf8', timeout: 10_000 }
      )
      console.log('  Snapshots deleted from DB')
    } catch { /* best effort */ }

    // ================================================================
    // Results
    // ================================================================
    const totalMs = resumeMs + firstCmdMs
    console.log(`\n${'='.repeat(60)}`)
    console.log(`  NFS PRE-WARM RESUME RESULTS`)
    console.log(`  (after full server restart — no in-memory cache)`)
    console.log(`${'='.repeat(60)}`)
    console.log()
    console.log(`  Resume:          ${secs(resumeMs).padStart(6)}s`)
    console.log(`  First command:   ${secs(firstCmdMs).padStart(6)}s`)
    console.log(`  Second command:  ${secs(secondCmdMs).padStart(6)}s`)
    console.log(`  ─────────────────────────`)
    console.log(`  Total (resume + first cmd): ${secs(totalMs)}s`)
    console.log()

    if (totalMs < 10_000) {
      console.log(`  RESULT: NFS pre-warm is working.`)
      console.log(`  Resume + first command < 10s proves chunks came from NFS, not GCS.`)
      console.log(`  (GCS-only cold resume for this template is typically 30-40s)`)
    } else {
      console.log(`  WARNING: Resume was slow (${secs(totalMs)}s).`)
      console.log(`  NFS pre-warm may not have completed before server restart.`)
      console.log(`  Check orchestrator logs for [NFS PRE-WARM] messages.`)
    }

    console.log()
    console.log(`${'='.repeat(60)}\n`)

  }, 300_000)
})
