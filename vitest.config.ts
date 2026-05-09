import { defineConfig } from 'vitest/config'
import 'dotenv/config'

export default defineConfig({
  test: {
    // Run test files sequentially (one by one) to avoid resource contention
    // when running integration tests that create VMs
    fileParallelism: false,

    // Per-test cap. 2 minutes is enough for any single create/pause/resume
    // cycle on dev; tests that overrun are stuck on a poll loop or hung work
    // and we'd rather see them fail fast than block the whole suite.
    testTimeout: 120_000, // 2 minutes

    // Hook timeout for beforeAll/afterAll
    hookTimeout: 120_000, // 2 minutes
  },
})
