#!/usr/bin/env bun
import { execSync } from 'node:child_process'
// FUSE3 smoke test — validates FUSE mount/read/unmount from Bun
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const mountDir = join(import.meta.dir, 'mnt')
const fuseBin = join(import.meta.dir, 'hello_fuse')

function cleanup() {
  try {
    execSync(`fusermount -u ${mountDir} 2>/dev/null`)
  } catch {}
}

// Setup
cleanup()
if (!existsSync(mountDir)) {
  mkdirSync(mountDir)
}

console.log('[smoke] Starting FUSE3 mount...')
const proc = Bun.spawn([fuseBin, '-f', mountDir], {
  stdout: 'pipe',
  stderr: 'pipe',
})

// Wait for mount
await Bun.sleep(500)

let passed = 0
let failed = 0

function assert(label: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${label}`)
    passed++
  } catch (e: any) {
    console.log(`  ✗ ${label}: ${e.message}`)
    failed++
  }
}

try {
  assert('mount point exists', () => {
    if (!existsSync(mountDir)) {
      throw new Error('mount dir missing')
    }
  })

  assert('readdir returns hello.txt', () => {
    const entries = readdirSync(mountDir)
    if (!entries.includes('hello.txt')) {
      throw new Error(`got: ${entries}`)
    }
  })

  assert('read hello.txt returns JSON', () => {
    const content = readFileSync(join(mountDir, 'hello.txt'), 'utf-8')
    const data = JSON.parse(content)
    if (data.smoke !== 'test') {
      throw new Error(`unexpected: ${content}`)
    }
    if (data.fuse3 !== true) {
      throw new Error('fuse3 not true')
    }
  })

  assert('nonexistent file throws', () => {
    try {
      readFileSync(join(mountDir, 'nope.txt'), 'utf-8')
      throw new Error('should have thrown')
    } catch (e: any) {
      if (e.code !== 'ENOENT') {
        throw new Error(`expected ENOENT, got ${e.code}`)
      }
    }
  })
} finally {
  // Unmount
  cleanup()
  proc.kill()
  await proc.exited
}

console.log(`\n[smoke] ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
