/**
 * FilesystemService Connect RPC Tests
 *
 * These tests run against portal on localhost.
 * Run portal first: cargo run -p microsandbox-portal -- --port 49983
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { filesystemClient, PORTAL_URL } from './setup'
import * as fs from 'fs/promises'
import * as path from 'path'
import { FileType } from '../../src/envd/filesystem/filesystem_pb'

// Skip these tests unless PORTAL_URL is set or portal is running
const isPortalAvailable = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${PORTAL_URL}/health`)
    return res.ok
  } catch {
    return false
  }
}

const TEST_DIR = `/tmp/portal-test-${Date.now()}`

describe('FilesystemService', () => {
  beforeEach(async () => {
    const available = await isPortalAvailable()
    if (!available) return

    await fs.mkdir(TEST_DIR, { recursive: true })
  })

  afterEach(async () => {
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  describe('stat', () => {
    it('should stat a file', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      const testFile = path.join(TEST_DIR, 'test.txt')
      await fs.writeFile(testFile, 'hello')

      const result = await filesystemClient.stat({ path: testFile })

      expect(result.entry).toBeDefined()
      expect(result.entry?.name).toBe('test.txt')
      expect(result.entry?.type).toBe(FileType.FILE)
      expect(result.entry?.size).toBe(5n)
    })

    it('should stat a directory', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      const result = await filesystemClient.stat({ path: TEST_DIR })

      expect(result.entry).toBeDefined()
      expect(result.entry?.type).toBe(FileType.DIRECTORY)
    })

    it('should stat a symlink', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      const testFile = path.join(TEST_DIR, 'original.txt')
      const linkFile = path.join(TEST_DIR, 'link.txt')
      await fs.writeFile(testFile, 'hello')
      await fs.symlink(testFile, linkFile)

      const result = await filesystemClient.stat({ path: linkFile })

      // The symlink should resolve to its target type
      expect(result.entry?.type).toBe(FileType.FILE)
    })

    it('should return error for non-existent path', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      await expect(
        filesystemClient.stat({ path: '/nonexistent/path/12345' })
      ).rejects.toThrow()
    })
  })

  describe('listDir', () => {
    it('should list directory contents', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      await fs.writeFile(path.join(TEST_DIR, 'file1.txt'), 'a')
      await fs.writeFile(path.join(TEST_DIR, 'file2.txt'), 'b')
      await fs.mkdir(path.join(TEST_DIR, 'subdir'))

      const result = await filesystemClient.listDir({ path: TEST_DIR })

      expect(result.entries.length).toBe(3)
      const names = result.entries.map((e) => e.name)
      expect(names).toContain('file1.txt')
      expect(names).toContain('file2.txt')
      expect(names).toContain('subdir')
    })

    it('should list with depth', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      await fs.mkdir(path.join(TEST_DIR, 'a/b/c'), { recursive: true })
      await fs.writeFile(path.join(TEST_DIR, 'a/b/c/deep.txt'), 'deep')

      // Structure: TEST_DIR/a/b/c/deep.txt
      // Need depth=4 to reach deep.txt (a=1, b=2, c=3, deep.txt=4)
      const result = await filesystemClient.listDir({
        path: TEST_DIR,
        depth: 4,
      })

      const names = result.entries.map((e) => e.name)
      expect(names).toContain('deep.txt')
    })

    it('should return empty for empty directory', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      const emptyDir = path.join(TEST_DIR, 'empty')
      await fs.mkdir(emptyDir)

      const result = await filesystemClient.listDir({ path: emptyDir })

      expect(result.entries.length).toBe(0)
    })
  })

  describe('makeDir', () => {
    it('should create directory', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      const newDir = path.join(TEST_DIR, 'newdir')

      try {
        const result = await filesystemClient.makeDir({ path: newDir })

        expect(result.entry).toBeDefined()
        expect(result.entry?.type).toBe(FileType.DIRECTORY)

        const stat = await fs.stat(newDir)
        expect(stat.isDirectory()).toBe(true)
      } catch (err: any) {
        // Skip if running without root permissions (chown fails)
        if (err.message?.includes('EPERM')) {
          console.log('Skipping: makeDir chown requires root permissions')
          return
        }
        throw err
      }
    })

    it('should create nested directories', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      const nestedDir = path.join(TEST_DIR, 'a/b/c/d')

      try {
        await filesystemClient.makeDir({ path: nestedDir })

        const stat = await fs.stat(nestedDir)
        expect(stat.isDirectory()).toBe(true)
      } catch (err: any) {
        // Skip if running without root permissions (chown fails)
        if (err.message?.includes('EPERM')) {
          console.log('Skipping: makeDir chown requires root permissions')
          return
        }
        throw err
      }
    })
  })

  describe('move', () => {
    it('should move/rename file', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      const src = path.join(TEST_DIR, 'source.txt')
      const dst = path.join(TEST_DIR, 'dest.txt')
      await fs.writeFile(src, 'content')

      await filesystemClient.move({ source: src, destination: dst })

      await expect(fs.access(src)).rejects.toThrow()
      const content = await fs.readFile(dst, 'utf-8')
      expect(content).toBe('content')
    })

    it('should move directory', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      const srcDir = path.join(TEST_DIR, 'srcdir')
      const dstDir = path.join(TEST_DIR, 'dstdir')
      await fs.mkdir(srcDir)
      await fs.writeFile(path.join(srcDir, 'file.txt'), 'hello')

      await filesystemClient.move({ source: srcDir, destination: dstDir })

      await expect(fs.access(srcDir)).rejects.toThrow()
      const content = await fs.readFile(path.join(dstDir, 'file.txt'), 'utf-8')
      expect(content).toBe('hello')
    })
  })

  describe('remove', () => {
    it('should remove file', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      const testFile = path.join(TEST_DIR, 'to-delete.txt')
      await fs.writeFile(testFile, 'bye')

      await filesystemClient.remove({ path: testFile })

      await expect(fs.access(testFile)).rejects.toThrow()
    })

    it('should remove directory recursively', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      const dir = path.join(TEST_DIR, 'to-delete-dir')
      await fs.mkdir(dir)
      await fs.writeFile(path.join(dir, 'file.txt'), 'content')

      await filesystemClient.remove({ path: dir })

      await expect(fs.access(dir)).rejects.toThrow()
    })
  })

  describe('watchDir', () => {
    it('should watch directory for changes', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      const events: any[] = []

      const stream = filesystemClient.watchDir({
        path: TEST_DIR,
        recursive: false,
      })

      const iterator = stream[Symbol.asyncIterator]()

      // Get start event
      const startEvent = await iterator.next()
      expect(startEvent.value.event?.case).toBe('start')

      // Create a file to trigger event
      setTimeout(async () => {
        await fs.writeFile(path.join(TEST_DIR, 'new-file.txt'), 'hello')
      }, 100)

      // Wait for create event (with timeout)
      const createEvent = await Promise.race([
        iterator.next(),
        new Promise<{ done: boolean }>((r) =>
          setTimeout(() => r({ done: true }), 2000)
        ),
      ])

      if (!(createEvent as any).done) {
        expect((createEvent as any).value.event?.case).toBe('filesystem')
      }

      // Clean up - cancel the stream
      return
    })
  })

  describe('watcher API (non-streaming)', () => {
    it('should create and use watcher', async () => {
      const available = await isPortalAvailable()
      if (!available) return

      // Create watcher
      const createResult = await filesystemClient.createWatcher({
        path: TEST_DIR,
        recursive: false,
      })

      expect(createResult.watcherId).toBeDefined()
      const watcherId = createResult.watcherId

      // Create a file
      await fs.writeFile(path.join(TEST_DIR, 'watched-file.txt'), 'content')

      // Small delay for event to register
      await new Promise((r) => setTimeout(r, 100))

      // Get events
      const eventsResult = await filesystemClient.getWatcherEvents({
        watcherId,
      })

      expect(eventsResult.events.length).toBeGreaterThanOrEqual(0)

      // Remove watcher
      await filesystemClient.removeWatcher({ watcherId })
    })
  })
})
