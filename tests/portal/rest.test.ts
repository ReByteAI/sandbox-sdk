/**
 * REST API Tests
 *
 * These tests run against portal on localhost.
 * Run portal first: cargo run -p microsandbox-portal -- --port 49983
 */

import { describe, it, expect } from 'vitest'
import { PORTAL_URL } from './setup'

// Skip these tests unless PORTAL_URL is set or portal is running
const isPortalAvailable = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${PORTAL_URL}/health`)
    return res.ok
  } catch {
    return false
  }
}

describe('REST API', () => {
  describe('GET /health', () => {
    it('should return 204 No Content (healthy)', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      const res = await fetch(`${PORTAL_URL}/health`)
      // Portal returns 204 No Content for health check
      expect(res.status).toBe(204)
    })
  })

  describe('GET /metrics', () => {
    it('should return metrics', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      const res = await fetch(`${PORTAL_URL}/metrics`)
      expect(res.ok).toBe(true)
    })
  })

  describe('GET /envs', () => {
    it('should return environment info', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      const res = await fetch(`${PORTAL_URL}/envs`)
      expect(res.ok).toBe(true)
    })
  })

  describe('POST /init', () => {
    it('should initialize environment', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      const res = await fetch(`${PORTAL_URL}/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          envVars: { TEST_VAR: 'test-value' },
        }),
      })
      expect(res.ok).toBe(true)
    })
  })
})
