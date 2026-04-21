import { Sandbox } from '../../src'

const API_URL = 'https://dev.rebyte.app'
const TEMPLATE_ID = 'd1da65c4-c6b2-46ee-9991-1b301b790be5'

async function main() {
  console.log('=== TEST: Start 5 VMs concurrently, then kill ===\n')
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
        console.log(`  VM${i+1} FAILED: ${err.message}`)
        return null
      })
  )

  const sandboxes = await Promise.all(promises)
  const created = sandboxes.filter(s => s !== null) as Sandbox[]
  console.log(`\nCreated ${created.length}/5 VMs in ${Date.now() - startTime}ms`)

  // Kill all
  console.log('\nKilling all VMs...')
  await Promise.all(created.map(async (sb, i) => {
    await sb.kill()
    console.log(`  VM${i+1} killed`)
  }))

  console.log(`\n=== RESULT: ${created.length}/5 succeeded ===`)
  process.exit(created.length === 5 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
