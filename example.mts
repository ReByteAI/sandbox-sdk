import { Sandbox } from './dist'
import { configDotenv } from 'dotenv'

configDotenv()

const domain = process.env.SANDBOX_DOMAIN || process.env.REBYTE_SANDBOX_DOMAIN
const apiUrl =
  process.env.SANDBOX_API_URL ||
  process.env.REBYTE_SANDBOX_API_URL ||
  (domain ? `https://${domain}` : undefined)

const sandbox = await Sandbox.create({
  apiKey: process.env.REBYTE_SANDBOX_API_KEY,
  apiUrl,
  domain,
})

console.log('Sandbox created:', sandbox.sandboxId)

await sandbox.kill()
console.log('Sandbox killed')
