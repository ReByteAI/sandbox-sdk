import { afterEach, assert, test, vi } from 'vitest'
import { ConnectionConfig } from '../src/connectionConfig'

function clearEndpointEnv() {
  vi.stubEnv('SANDBOX_DOMAIN', '')
  vi.stubEnv('SANDBOX_API_URL', '')
  vi.stubEnv('REBYTE_SANDBOX_DOMAIN', '')
  vi.stubEnv('REBYTE_SANDBOX_API_URL', '')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

test('requires endpoint configuration by default', () => {
  clearEndpointEnv()

  assert.throws(() => new ConnectionConfig(), /Sandbox API domain is required/)
})

test('api_url defaults from domain', () => {
  clearEndpointEnv()

  const config = new ConnectionConfig({ domain: 'sandbox.example.test' })
  assert.equal(config.apiUrl, 'https://sandbox.example.test')
})

test('api_url defaults from env domain', () => {
  clearEndpointEnv()
  vi.stubEnv('SANDBOX_DOMAIN', 'env.sandbox.example.test')

  const config = new ConnectionConfig()
  assert.equal(config.domain, 'env.sandbox.example.test')
  assert.equal(config.apiUrl, 'https://env.sandbox.example.test')
})

test('api_url in args', () => {
  clearEndpointEnv()

  const config = new ConnectionConfig({ apiUrl: 'http://localhost:8080' })
  assert.equal(config.domain, 'localhost:8080')
  assert.equal(config.apiUrl, 'http://localhost:8080')
})
