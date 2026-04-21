import { Sandbox } from '../src'

async function main() {
  const config = {
    apiUrl: 'https://dev.rebyte.app',
    apiKey: 'test-key',
    timeoutMs: 300_000,
  }
  const templateId = '0c9aac1b-9258-4fd1-aafd-9752f4b7f2ca'

  console.log('Creating sandbox...')
  const t0 = Date.now()
  const sandbox = await Sandbox.create(templateId, config)
  console.log(`Sandbox created: ${sandbox.sandboxId} (${Date.now() - t0}ms)`)

  // Check available memory
  const memInfo = await sandbox.commands.run('free -m && df -h /dev/shm')
  console.log('Memory info:\n' + memInfo.stdout)

  // Fill some memory
  console.log('Filling 2GB of memory...')
  const t1 = Date.now()
  await sandbox.commands.run('dd if=/dev/urandom of=/dev/shm/test bs=1M count=2000')
  console.log(`Memory filled: 2GB (${Date.now() - t1}ms)`)

  // Pause - this is what we're profiling
  console.log('\n=== PAUSING (profiling) ===')
  const t2 = Date.now()
  const paused = await Sandbox.pause(sandbox.sandboxId, config)
  const pauseTime = Date.now() - t2
  console.log(`Pause completed: ${paused} (${pauseTime}ms)`)

  // Check state
  const t3 = Date.now()
  const state = await Sandbox.getInfo(sandbox.sandboxId, config)
  console.log(`State check: ${state?.status} (${Date.now() - t3}ms)`)

  console.log(`\nTotal pause time: ${pauseTime}ms`)
}

main().catch(console.error)
