import { Sandbox } from '../../src'

const API_URL = 'https://dev.rebyte.app'
const TEMPLATE_ID = 'd1da65c4-c6b2-46ee-9991-1b301b790be5'

async function main() {
  console.log('=== TEST: Start 5 VMs, then PAUSE all concurrently ===\n')
  const startTime = Date.now()

  // Create 5 VMs in parallel
  console.log('Creating 5 VMs in parallel...')
  const promises = Array.from({ length: 5 }, (_, i) =>
    Sandbox.create(TEMPLATE_ID, { apiUrl: API_URL })
      .then(sb => {
        console.log(`  VM${i+1} created: ${sb.sandboxId} (${Date.now() - startTime}ms)`)
        return sb
      })
      .catch(err => {
        console.log(`  VM${i+1} CREATE FAILED: ${err.message}`)
        return null
      })
  )

  const sandboxes = await Promise.all(promises)
  const created = sandboxes.filter(s => s !== null) as Sandbox[]
  console.log(`\nCreated ${created.length}/5 VMs in ${Date.now() - startTime}ms`)

  // Pause all concurrently
  console.log('\nPausing all VMs concurrently...')
  const pauseStart = Date.now()
  const pauseResults = await Promise.all(created.map(async (sb, i) => {
    try {
      await sb.pause()
      console.log(`  VM${i+1} paused (${Date.now() - pauseStart}ms)`)
      return true
    } catch (err: any) {
      console.log(`  VM${i+1} PAUSE FAILED: ${err.message}`)
      return false
    }
  }))

  const paused = pauseResults.filter(r => r).length
  console.log(`\nPaused ${paused}/${created.length} VMs in ${Date.now() - pauseStart}ms`)

  console.log(`\n=== RESULT: Created ${created.length}/5, Paused ${paused}/${created.length} ===`)
  process.exit(created.length === 5 && paused === 5 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
