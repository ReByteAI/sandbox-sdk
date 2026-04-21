/**
 * Common test harness for SDK integration tests.
 *
 * Provides:
 * - Template configuration (small/large via TEST_TEMPLATE env var)
 * - Environment configuration (dev/prod via TEST_ENV env var)
 * - Shared setup helpers
 *
 * Usage:
 *   # Run with small template (default, 512MB, faster)
 *   npx vitest run tests/integration/sandbox.test.ts
 *
 *   # Run with large template (4GB, code-interpreter)
 *   TEST_TEMPLATE=large npx vitest run tests/integration/sandbox.test.ts
 *
 *   # Run against production
 *   TEST_ENV=prod npx vitest run tests/integration/sandbox.test.ts
 */

import { Sandbox } from '../../src'

//--------------------------------------------------------------------------------------------------
// Template Configuration
//--------------------------------------------------------------------------------------------------

/**
 * Template IDs - same for all environments (shared GCS bucket)
 */
/**
 * Default template: simple debian (rootfs-only, cold boot).
 * Override with TEST_TEMPLATE_ID env var.
 */
const DEFAULT_TEMPLATE_ID = '69e930b1-1427-44f7-a5c7-080b791a0a24'

export function getTemplateId(): string {
  return process.env.TEST_TEMPLATE_ID || DEFAULT_TEMPLATE_ID
}

//--------------------------------------------------------------------------------------------------
// Environment Configuration
//--------------------------------------------------------------------------------------------------

/**
 * Environment configurations for dev and prod.
 */
export const ENVIRONMENTS = {
  dev: {
    apiUrl: 'https://dev.rebyte.app',
    // Gateway requires real msb_ keys (no dev bypass) — put one in .env as REBYTE_SANDBOX_API_KEY
    apiKey: process.env.REBYTE_SANDBOX_API_KEY || 'test-key',
    domain: 'dev.rebyte.app',
  },
  prod: {
    apiUrl: 'https://prod.rebyte.app',
    apiKey: 'msb_test_REDACTED', // real key from DB, org_id='test-org'
    domain: 'prod.rebyte.app',
  },
} as const

export type Environment = keyof typeof ENVIRONMENTS

/**
 * Get environment configuration from TEST_ENV env var.
 * Default: dev
 */
export function getEnvironment(): Environment {
  return (process.env.TEST_ENV || 'dev') as Environment
}

/**
 * Get gateway configuration for current environment.
 */
export function getGatewayConfig() {
  return ENVIRONMENTS[getEnvironment()]
}

//--------------------------------------------------------------------------------------------------
// Database Configuration
//--------------------------------------------------------------------------------------------------

export function getDatabaseUrl(): string {
  const url = process.env.SUPABASE_DATABASE_URL
  if (!url) {
    throw new Error(
      'SUPABASE_DATABASE_URL must be set to run integration tests that talk to the database.'
    )
  }
  return url
}

//--------------------------------------------------------------------------------------------------
// API Key Seeding (for prod)
//--------------------------------------------------------------------------------------------------

/**
 * Ensure the test API key exists in the prod database.
 * This is needed because the prod gateway validates API keys against the database.
 */
export async function ensureProdApiKey(): Promise<void> {
  if (getEnvironment() !== 'prod') return

  const { execSync } = require('child_process')
  const apiKey = ENVIRONMENTS.prod.apiKey
  const crypto = require('crypto')

  // Generate SHA256 hash of the API key (how gateway validates it)
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex')
  const prefix = apiKey.substring(0, 16)
  const mask = `${prefix}...${apiKey.slice(-4)}`
  const dbUrl = getDatabaseUrl()

  console.log('=== Checking Prod API Key ===')
  console.log(`API Key prefix: ${prefix}`)
  console.log(`Hash: ${hash.substring(0, 16)}...`)

  try {
    // Check if key exists
    const checkResult = execSync(
      `psql "${dbUrl}" -t -c "SELECT COUNT(*) FROM team_api_keys WHERE api_key_hash = '${hash}';"`,
      { encoding: 'utf8', timeout: 10_000 }
    ).trim()

    if (parseInt(checkResult) > 0) {
      console.log('API key already exists in prod database')
      return
    }

    // Insert the key
    console.log('Inserting API key into prod database...')
    execSync(
      `psql "${dbUrl}" -c "INSERT INTO team_api_keys (org_id, api_key_hash, api_key_prefix, api_key_mask, name) VALUES ('test-org', '${hash}', '${prefix}', '${mask}', 'SDK Integration Test Key');"`,
      { encoding: 'utf8', timeout: 10_000 }
    )
    console.log('API key inserted successfully')
  } catch (e: any) {
    console.log(`Warning: Failed to seed API key: ${e.message}`)
    console.log('Tests may fail if API key is not in the database')
  }
}

//--------------------------------------------------------------------------------------------------
// Test Helpers
//--------------------------------------------------------------------------------------------------

/**
 * Print test header with template and environment info.
 */
export function printTestHeader(testName: string): void {
  const env = getEnvironment()
  const config = getGatewayConfig()

  console.log(`\n${'='.repeat(50)}`)
  console.log(`  ${testName}`)
  console.log(`  Template: ${getTemplateId()}`)
  console.log(`  Environment: ${env}`)
  console.log(`  API URL: ${config.apiUrl}`)
  console.log(`${'='.repeat(50)}\n`)
}

/**
 * Create a sandbox with current configuration.
 */
export async function createTestSandbox(options: {
  timeoutMs?: number
} = {}): Promise<Sandbox> {
  const config = getGatewayConfig()
  const templateId = getTemplateId()

  return await Sandbox.create(templateId, {
    ...config,
    timeoutMs: options.timeoutMs ?? 300_000,
  })
}

/**
 * Get namespace for current environment.
 */
export function getNamespace(): string {
  return getEnvironment() === 'prod' ? 'test-org' : 'default'
}
