import { Sandbox } from './dist/index.js'

const apiKey = 'test-key'
const apiUrl = 'https://dev.rebyte.app'
const domain = 'dev.rebyte.app'

console.log('Creating sandbox...')
const sbx = await Sandbox.create('a8b495d6-a386-4863-9516-f853cfbb8133', {
  apiKey,
  apiUrl,
  domain,
  timeoutMs: 300000,
})

console.log(`Created sandbox: ${sbx.sandboxId}`)

// Start pausing it
console.log('Starting pause...')
const pausePromise = sbx.pause()

// Wait a moment to ensure it's in "Pausing" state
await new Promise(resolve => setTimeout(resolve, 1000))

console.log('Now trying to kill it while pausing...')
try {
  await sbx.kill()
  console.log('✅ Kill succeeded!')
} catch (err) {
  console.log('❌ Kill failed:', err.message)
}

// Check if pause completed or was interrupted
try {
  await pausePromise
  console.log('⚠️  Pause completed')
} catch (err) {
  console.log('⚠️  Pause was interrupted:', err.message)
}
