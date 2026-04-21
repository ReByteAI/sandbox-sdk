import { assert, test } from 'vitest'
import { ConnectionConfig } from '../src/connectionConfig'

test('api_url defaults correctly', () => {
  const config = new ConnectionConfig()
  assert.equal(config.apiUrl, 'https://prod.rebyte.app')
})

test('api_url in args', () => {
  const config = new ConnectionConfig({ apiUrl: 'http://localhost:8080' })
  assert.equal(config.apiUrl, 'http://localhost:8080')
})
