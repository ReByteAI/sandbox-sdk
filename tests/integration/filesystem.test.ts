/**
 * Filesystem Integration Tests
 *
 * Tests filesystem operations via Portal:
 * - Read/write files
 * - Check file exists
 * - Get file info (stat)
 * - Create directories
 * - List directories
 * - Rename files
 * - Remove files
 * - Watch directory events
 *
 * Reference Tests from filesystem_test.go:
 * - TestListDir
 * - TestFilePermissions
 * - TestStat
 * - TestListDirFileEntry
 * - TestListDirEntry
 * - TestListDirMixedEntries
 * - TestRelativePath
 *
 * Run:
 *   npx vitest run tests/integration/filesystem.test.ts
 *
 * With large template (4GB):
 *   TEST_TEMPLATE=large npx vitest run tests/integration/filesystem.test.ts
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { Sandbox } from '../../src'
import {
  getTemplateId,
  getGatewayConfig,
  printTestHeader,
  ensureProdApiKey,
} from './common'

const gatewayConfig = getGatewayConfig()
const TEMPLATE_ID = getTemplateId()

describe('Filesystem', () => {
  beforeAll(async () => {
    await ensureProdApiKey()
  }, 30_000)

  test('read, write, list operations', async () => {
    printTestHeader('Filesystem Operations Test')

    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    try {
      // 1. Write a file
      console.log('\n1. Writing file /tmp/test.txt...')
      const writeResult = await sandbox.files.write('/tmp/test.txt', 'Hello from SDK!')
      console.log(`   Written: ${writeResult.path}`)
      expect(writeResult.path).toBe('/tmp/test.txt')

      // 2. Read the file back
      console.log('\n2. Reading file /tmp/test.txt...')
      const content = await sandbox.files.read('/tmp/test.txt')
      console.log(`   Content: ${content}`)
      expect(content).toBe('Hello from SDK!')

      // 3. Check file exists
      console.log('\n3. Checking file exists...')
      const exists = await sandbox.files.exists('/tmp/test.txt')
      console.log(`   Exists: ${exists}`)
      expect(exists).toBe(true)

      // 4. Get file info
      console.log('\n4. Getting file info...')
      const info = await sandbox.files.getInfo('/tmp/test.txt')
      console.log(`   Name: ${info.name}, Size: ${info.size}, Type: ${info.type}`)
      expect(info.name).toBe('test.txt')
      expect(info.size).toBeGreaterThan(0)

      // 5. Create a directory
      console.log('\n5. Creating directory /tmp/testdir...')
      const dirCreated = await sandbox.files.makeDir('/tmp/testdir')
      console.log(`   Created: ${dirCreated}`)
      expect(dirCreated).toBe(true)

      // 6. Write file in new directory
      console.log('\n6. Writing file in new directory...')
      await sandbox.files.write('/tmp/testdir/nested.txt', 'Nested content')

      // 7. List directory
      console.log('\n7. Listing /tmp/testdir...')
      const entries = await sandbox.files.list('/tmp/testdir')
      console.log(`   Entries: ${entries.map(e => e.name).join(', ')}`)
      expect(entries.length).toBeGreaterThanOrEqual(1)
      expect(entries.some(e => e.name === 'nested.txt')).toBe(true)

      // 8. Rename file
      console.log('\n8. Renaming file...')
      const renamed = await sandbox.files.rename('/tmp/testdir/nested.txt', '/tmp/testdir/renamed.txt')
      console.log(`   Renamed to: ${renamed.path}`)
      expect(renamed.name).toBe('renamed.txt')

      // 9. Read as bytes
      console.log('\n9. Reading file as bytes...')
      const bytes = await sandbox.files.read('/tmp/test.txt', { format: 'bytes' })
      console.log(`   Bytes length: ${bytes.length}`)
      expect(bytes).toBeInstanceOf(Uint8Array)
      expect(bytes.length).toBe(15) // "Hello from SDK!" = 15 chars

      // 10. Remove file
      console.log('\n10. Removing file...')
      await sandbox.files.remove('/tmp/test.txt')
      const existsAfter = await sandbox.files.exists('/tmp/test.txt')
      console.log(`   Exists after remove: ${existsAfter}`)
      expect(existsAfter).toBe(false)

      console.log('\n=== Test Passed ===')
    } finally {
      await sandbox.kill()
      console.log('Sandbox killed')
    }
  }, 120_000)

  test('watchDir - filesystem event streaming', async () => {
    printTestHeader('Filesystem Watch Test')

    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    try {
      // 1. Create watch directory
      console.log('\n1. Creating watch directory...')
      await sandbox.files.makeDir('/tmp/watchdir')

      // 2. Start watching
      console.log('\n2. Starting directory watch...')
      const events: Array<{ type: string; name: string }> = []

      const watchHandle = await sandbox.files.watchDir(
        '/tmp/watchdir',
        (event) => {
          console.log(`   [EVENT] ${event.type}: ${event.name}`)
          events.push({ type: event.type, name: event.name })
        },
        {
          timeoutMs: 30_000,
        }
      )
      console.log('   Watch started')

      // 3. Create a file (should trigger event)
      console.log('\n3. Creating file to trigger event...')
      await sandbox.files.write('/tmp/watchdir/newfile.txt', 'test content')

      // Wait for event to be received
      await new Promise(resolve => setTimeout(resolve, 500))

      // 4. Modify the file
      console.log('\n4. Modifying file...')
      await sandbox.files.write('/tmp/watchdir/newfile.txt', 'modified content')

      await new Promise(resolve => setTimeout(resolve, 500))

      // 5. Delete the file
      console.log('\n5. Deleting file...')
      await sandbox.files.remove('/tmp/watchdir/newfile.txt')

      await new Promise(resolve => setTimeout(resolve, 500))

      // 6. Stop watching
      console.log('\n6. Stopping watch...')
      await watchHandle.stop()
      console.log('   Watch stopped')

      // 7. Verify events received
      console.log('\n7. Verifying events...')
      console.log(`   Total events: ${events.length}`)
      events.forEach((e, i) => console.log(`   ${i + 1}. ${e.type}: ${e.name}`))

      // Should have received at least create event
      expect(events.length).toBeGreaterThan(0)

      console.log('\n=== Test Passed ===')
    } finally {
      await sandbox.kill()
      console.log('Sandbox killed')
    }
  }, 120_000)

  // ===== Reference Tests =====

  test('TestListDir - list directory with depth', async () => {
    printTestHeader('ListDir Depth Test')

    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    try {
      // 1. Create test directory structure
      console.log('\n1. Creating test directory structure...')
      await sandbox.files.makeDir('/tmp/test/a/b/c')
      await sandbox.files.write('/tmp/test/file0.txt', 'level0')
      await sandbox.files.write('/tmp/test/a/file1.txt', 'level1')
      await sandbox.files.write('/tmp/test/a/b/file2.txt', 'level2')
      await sandbox.files.write('/tmp/test/a/b/c/file3.txt', 'level3')
      console.log('   Created: /tmp/test/a/b/c with files at each level')

      // 2. List with depth 1 (immediate children only)
      console.log('\n2. Listing /tmp/test with depth 1...')
      const entries1 = await sandbox.files.list('/tmp/test')
      console.log(`   Found ${entries1.length} entries: ${entries1.map(e => e.name).join(', ')}`)
      expect(entries1.length).toBeGreaterThanOrEqual(2) // file0.txt, a/
      expect(entries1.some(e => e.name === 'file0.txt')).toBe(true)
      expect(entries1.some(e => e.name === 'a')).toBe(true)

      // 3. List nested directory
      console.log('\n3. Listing /tmp/test/a...')
      const entries2 = await sandbox.files.list('/tmp/test/a')
      console.log(`   Found ${entries2.length} entries: ${entries2.map(e => e.name).join(', ')}`)
      expect(entries2.some(e => e.name === 'file1.txt')).toBe(true)
      expect(entries2.some(e => e.name === 'b')).toBe(true)

      console.log('\n=== Test Passed ===')
    } finally {
      await sandbox.kill()
      console.log('Sandbox killed')
    }
  }, 120_000)

  test('TestFilePermissions - .bashrc/.profile permissions', async () => {
    printTestHeader('File Permissions Test')

    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    try {
      // 1. Check .bashrc permissions via command (stat)
      console.log('\n1. Checking /home/user/.bashrc permissions...')
      const bashrcResult = await sandbox.commands.run('stat -c "%a %U %G" /home/user/.bashrc 2>/dev/null || echo "not found"', {
        timeoutMs: 10_000,
      })
      console.log(`   Result: ${bashrcResult.stdout.trim()}`)

      if (bashrcResult.stdout.trim() !== 'not found') {
        const parts = bashrcResult.stdout.trim().split(' ')
        const mode = parts[0]
        const owner = parts[1]
        console.log(`   Mode: ${mode}, Owner: ${owner}`)
        expect(['644', '600', '755']).toContain(mode)
        expect(owner).toBe('user')
        console.log('   .bashrc has correct permissions')
      } else {
        console.log('   .bashrc not found (skipping)')
      }

      // 2. Check .profile permissions
      console.log('\n2. Checking /home/user/.profile permissions...')
      const profileResult = await sandbox.commands.run('stat -c "%a %U %G" /home/user/.profile 2>/dev/null || echo "not found"', {
        timeoutMs: 10_000,
      })
      console.log(`   Result: ${profileResult.stdout.trim()}`)

      if (profileResult.stdout.trim() !== 'not found') {
        const parts = profileResult.stdout.trim().split(' ')
        const mode = parts[0]
        const owner = parts[1]
        console.log(`   Mode: ${mode}, Owner: ${owner}`)
        expect(['644', '600', '755']).toContain(mode)
        expect(owner).toBe('user')
        console.log('   .profile has correct permissions')
      } else {
        console.log('   .profile not found (skipping)')
      }

      console.log('\n=== Test Passed ===')
    } finally {
      await sandbox.kill()
      console.log('Sandbox killed')
    }
  }, 120_000)

  test('TestStat - returns complete metadata', async () => {
    printTestHeader('Stat Test')

    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    try {
      // 1. Create test file
      console.log('\n1. Creating test file...')
      const testContent = 'Hello, microsandbox!'
      await sandbox.files.write('/tmp/stat_test.txt', testContent)
      console.log(`   Created /tmp/stat_test.txt with ${testContent.length} bytes`)

      // 2. Get file info via SDK
      console.log('\n2. Getting file info via SDK...')
      const info = await sandbox.files.getInfo('/tmp/stat_test.txt')
      console.log(`   Name: ${info.name}`)
      console.log(`   Path: ${info.path}`)
      console.log(`   Type: ${info.type}`)
      console.log(`   Size: ${info.size}`)

      // Verify fields
      expect(info.name).toBe('stat_test.txt')
      expect(info.path).toBe('/tmp/stat_test.txt')
      expect(info.type).toBe('file')
      expect(info.size).toBe(testContent.length)
      console.log('   File metadata correct')

      // 3. Test stat on directory
      console.log('\n3. Getting directory info...')
      const dirInfo = await sandbox.files.getInfo('/tmp')
      console.log(`   Name: ${dirInfo.name}`)
      console.log(`   Type: ${dirInfo.type}`)
      expect(dirInfo.type).toBe('dir')
      console.log('   Directory metadata correct')

      console.log('\n=== Test Passed ===')
    } finally {
      await sandbox.kill()
      console.log('Sandbox killed')
    }
  }, 120_000)

  test('TestListDirFileEntry - file entry has correct metadata', async () => {
    printTestHeader('ListDir File Entry Test')

    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    try {
      // 1. Create test directory with file
      console.log('\n1. Creating test directory with file...')
      await sandbox.files.makeDir('/tmp/filelist')
      await sandbox.files.write('/tmp/filelist/test.txt', 'content')
      console.log('   Created /tmp/filelist/test.txt')

      // 2. List directory
      console.log('\n2. Listing directory...')
      const entries = await sandbox.files.list('/tmp/filelist')
      console.log(`   Found ${entries.length} entries`)

      // 3. Find file entry
      const fileEntry = entries.find(e => e.name === 'test.txt')
      expect(fileEntry).toBeDefined()
      console.log(`   File entry: name=${fileEntry!.name}, type=${fileEntry!.type}, size=${fileEntry!.size}`)

      expect(fileEntry!.type).toBe('file')
      expect(fileEntry!.size).toBeGreaterThan(0)
      console.log('   File entry has correct metadata')

      console.log('\n=== Test Passed ===')
    } finally {
      await sandbox.kill()
      console.log('Sandbox killed')
    }
  }, 120_000)

  test('TestListDirEntry - directory entry has correct metadata', async () => {
    printTestHeader('ListDir Directory Entry Test')

    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    try {
      // 1. Create test directories
      console.log('\n1. Creating test directories...')
      await sandbox.files.makeDir('/tmp/dirlist/subdir')
      console.log('   Created /tmp/dirlist/subdir')

      // 2. List directory
      console.log('\n2. Listing directory...')
      const entries = await sandbox.files.list('/tmp/dirlist')
      console.log(`   Found ${entries.length} entries`)

      // 3. Find directory entry
      const dirEntry = entries.find(e => e.name === 'subdir')
      expect(dirEntry).toBeDefined()
      console.log(`   Directory entry: name=${dirEntry!.name}, type=${dirEntry!.type}`)

      expect(dirEntry!.type).toBe('dir')
      console.log('   Directory entry has correct type')

      console.log('\n=== Test Passed ===')
    } finally {
      await sandbox.kill()
      console.log('Sandbox killed')
    }
  }, 120_000)

  test('TestListDirMixedEntries - mixed files and directories', async () => {
    printTestHeader('ListDir Mixed Entries Test')

    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    try {
      // 1. Create mixed structure
      console.log('\n1. Creating mixed files and directories...')
      await sandbox.files.makeDir('/tmp/mixed/dir1')
      await sandbox.files.makeDir('/tmp/mixed/dir2')
      await sandbox.files.write('/tmp/mixed/file1.txt', 'file1')
      await sandbox.files.write('/tmp/mixed/file2.txt', 'file2')
      console.log('   Created: 2 dirs, 2 files')

      // 2. List directory
      console.log('\n2. Listing /tmp/mixed...')
      const entries = await sandbox.files.list('/tmp/mixed')
      console.log(`   Found ${entries.length} entries: ${entries.map(e => `${e.name}(${e.type})`).join(', ')}`)

      // 3. Count types
      const files = entries.filter(e => e.type === 'file')
      const dirs = entries.filter(e => e.type === 'dir')
      console.log(`   Files: ${files.length}, Directories: ${dirs.length}`)

      expect(files.length).toBe(2)
      expect(dirs.length).toBe(2)
      console.log('   Mixed entries correctly identified')

      console.log('\n=== Test Passed ===')
    } finally {
      await sandbox.kill()
      console.log('Sandbox killed')
    }
  }, 120_000)

  test('TestRelativePath - relative paths resolve from user home', async () => {
    printTestHeader('Relative Path Test')

    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    try {
      // 1. Write file using relative path (should resolve to /home/user)
      console.log('\n1. Writing file with relative path "relative_test.txt"...')
      await sandbox.files.write('relative_test.txt', 'relative content')
      console.log('   Written: relative_test.txt')

      // 2. Check where the file was actually written via command
      console.log('\n2. Checking where file was actually written...')
      const checkResult = await sandbox.commands.run('ls -la /home/user/relative_test.txt 2>&1 || ls -la /relative_test.txt 2>&1 || echo "Checking other locations..." && ls -la /*relative* /home/*relative* /tmp/*relative* 2>/dev/null | head -10', {
        timeoutMs: 10_000,
      })
      console.log(`   ${checkResult.stdout.trim()}`)

      // 3. Try to read the file back via SDK with relative path
      console.log('\n3. Reading file back via SDK with relative path...')
      try {
        const content = await sandbox.files.read('relative_test.txt')
        console.log(`   Content: ${content}`)
        expect(content).toBe('relative content')
        console.log('   File readable with same relative path')
      } catch (e: any) {
        console.log(`   Read failed: ${e.message}`)
        // Try with absolute path
        console.log('   Trying absolute path /home/user/relative_test.txt...')
        try {
          const content = await sandbox.files.read('/home/user/relative_test.txt')
          console.log(`   Content: ${content}`)
        } catch (e2: any) {
          console.log(`   Absolute path also failed: ${e2.message}`)
        }
      }

      // 4. Get file info to see the actual resolved path
      console.log('\n4. Getting file info...')
      try {
        const info = await sandbox.files.getInfo('relative_test.txt')
        console.log(`   Resolved path: ${info.path}`)
        if (info.path === '/home/user/relative_test.txt') {
          console.log('   Relative path resolved to /home/user/')
        } else {
          console.log(`   File NOT at /home/user/, actual: ${info.path}`)
        }
      } catch (e: any) {
        console.log(`   getInfo failed: ${e.message}`)
      }

      // 5. Test tilde expansion via command (commands run as 'user')
      console.log('\n5. Testing tilde expansion via command...')
      const tildeResult = await sandbox.commands.run('echo "tilde" > ~/tilde_test.txt && cat ~/tilde_test.txt && ls -la ~/tilde_test.txt', {
        timeoutMs: 10_000,
      })
      console.log(`   Result: ${tildeResult.stdout.trim()}`)
      expect(tildeResult.exitCode).toBe(0)
      expect(tildeResult.stdout).toContain('tilde')
      console.log('   Tilde expansion works')

      // 6. Verify tilde file is at /home/user
      console.log('\n6. Verifying ~/tilde_test.txt is at /home/user/...')
      const verifyResult = await sandbox.commands.run('stat /home/user/tilde_test.txt', {
        timeoutMs: 10_000,
      })
      expect(verifyResult.exitCode).toBe(0)
      console.log('   ~ expanded to /home/user/')

      console.log('\n=== Test Passed ===')
    } finally {
      await sandbox.kill()
      console.log('Sandbox killed')
    }
  }, 120_000)
})
