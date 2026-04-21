import { defineConfig } from 'vitest/config'
import 'dotenv/config'

export default defineConfig({
  test: {
    // Run test files sequentially (one by one) to avoid resource contention
    // when running integration tests that create VMs
    fileParallelism: false,

    // Increase timeout for integration tests (VMs take time to start/pause)
    testTimeout: 300_000, // 5 minutes

    // Hook timeout for beforeAll/afterAll
    hookTimeout: 120_000, // 2 minutes
  },
})
