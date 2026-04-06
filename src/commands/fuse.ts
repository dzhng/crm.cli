import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Command } from 'commander'

import { generateFS } from '../export-fs'
import { slugify } from '../fuse-json'
import { die, getCtx } from '../lib/helpers'

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

// Parse a .pc file and return [cflags..., libs...] without needing pkg-config.
function parsePcFlags(pcFile: string): string[] | null {
  if (!existsSync(pcFile)) {
    return null
  }
  const content = readFileSync(pcFile, 'utf-8')
  const vars: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m) {
      vars[m[1]] = m[2]
    }
  }
  const expand = (s: string): string =>
    s.replace(/\$\{(\w+)\}/g, (_, k) => expand(vars[k] ?? ''))
  const libs = content.match(/^Libs:\s*(.+)$/m)?.[1]
  const cflags = content.match(/^Cflags:\s*(.+)$/m)?.[1]
  if (!(libs && cflags)) {
    return null
  }
  return [
    ...expand(cflags).trim().split(/\s+/),
    ...expand(libs).trim().split(/\s+/),
  ].filter(Boolean)
}

export function registerFuseCommands(program: Command) {
  program
    .command('mount')
    .description('Mount CRM as virtual filesystem (requires FUSE)')
    .argument('[mountpoint]', 'Mount point directory')
    .option('--readonly', 'Mount read-only')
    .action(async (mountpoint, opts) => {
      const { config } = await getCtx()
      const mp = mountpoint || config.mount.default_path

      if (!existsSync(mp)) {
        mkdirSync(mp, { recursive: true })
      }

      // Check if FUSE helper binary exists
      const helperPath = join(homedir(), '.crm', 'bin', 'crm-fuse')

      // On macOS, force recompile if the binary is missing LC_RPATH (common after
      // installing FUSE-T without pkg-config in PATH — the old binary links via
      // @rpath but has no rpath entry, so dyld can't find the dylib).
      if (process.platform === 'darwin' && existsSync(helperPath)) {
        const check = spawnSync('otool', ['-l', helperPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        if (!check.stdout?.toString().includes('LC_RPATH')) {
          unlinkSync(helperPath)
        }
      }

      if (!existsSync(helperPath)) {
        // Try to compile it
        const srcPath = join(import.meta.dir, '..', 'fuse-helper.c')
        if (!existsSync(srcPath)) {
          die(
            'Error: FUSE helper not found. Install FUSE dependencies and rebuild, or use `crm export-fs` instead.',
          )
        }
        ensureDir(join(homedir(), '.crm', 'bin'))
        const fuseFlags = (() => {
          // Try pkg-config fuse3 first (Linux, and macOS if pkg-config is in PATH)
          const pc3 = spawnSync('pkg-config', ['--cflags', '--libs', 'fuse3'])
          if (pc3.status === 0 && pc3.stdout) {
            return pc3.stdout.toString().trim().split(/\s+/)
          }
          if (process.platform === 'darwin') {
            // FUSE-T: try pkg-config with explicit PKG_CONFIG_PATH, then parse .pc directly
            for (const dir of [
              '/usr/local/lib/pkgconfig',
              '/opt/homebrew/lib/pkgconfig',
            ]) {
              const pc = spawnSync(
                'pkg-config',
                ['--cflags', '--libs', 'fuse3'],
                { env: { ...process.env, PKG_CONFIG_PATH: dir } },
              )
              if (pc.status === 0 && pc.stdout) {
                return pc.stdout.toString().trim().split(/\s+/)
              }
              // pkg-config not in PATH — parse .pc file directly (preserves -Wl,-rpath,...)
              const flags = parsePcFlags(join(dir, 'fuse3.pc'))
              if (flags) {
                return flags
              }
            }
            die('Error: FUSE-T not found. Install with: brew install fuse-t')
          }
          return ['-lfuse3', '-lpthread']
        })()
        const compile = spawnSync(
          'gcc',
          ['-o', helperPath, srcPath, ...fuseFlags],
          { stdio: ['pipe', 'pipe', 'pipe'] },
        )
        if (compile.status !== 0) {
          const hint =
            process.platform === 'darwin'
              ? 'Install FUSE-T: brew install fuse-t'
              : 'Install libfuse3-dev (apt) or fuse3-devel (yum).'
          die(
            `Error: Failed to compile FUSE helper. ${hint}\n${compile.stderr?.toString() || ''}`,
          )
        }
      }

      // Start the TS FUSE daemon (detached so the CLI can exit)
      const socketPath = join(homedir(), '.crm', `fuse-${slugify(mp)}.sock`)
      const daemonPath = join(import.meta.dir, '..', 'fuse-daemon.ts')

      const daemonProc = spawn(
        'bun',
        [
          'run',
          daemonPath,
          socketPath,
          config.database.path,
          ...config.pipeline.stages,
        ],
        { stdio: 'ignore', detached: true },
      )
      daemonProc.unref()

      // Wait for daemon socket
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        if (existsSync(socketPath)) {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      if (!existsSync(socketPath)) {
        daemonProc.kill()
        die('Error: FUSE daemon failed to start.')
      }

      // Spawn the FUSE helper (detached so the CLI can exit)
      const fuseArgs = ['-f', mp, '--', socketPath]
      if (opts.readonly || config.mount.readonly) {
        fuseArgs.unshift('-o', 'ro')
      }

      const fuseProc = spawn(helperPath, fuseArgs, {
        stdio: 'ignore',
        detached: true,
      })
      // Don't unref yet — need to detect early crash before daemonizing

      // Wait briefly for mount to succeed
      await new Promise((resolve) => setTimeout(resolve, 500))

      if (fuseProc.exitCode !== null) {
        daemonProc.kill()
        die('Error: FUSE mount failed. Is FUSE available?')
      }

      fuseProc.unref()

      // Write PID file for unmount
      const pidFile = join(homedir(), '.crm', `mount-${slugify(mp)}.pid`)
      writeFileSync(pidFile, `${fuseProc.pid}\n${daemonProc.pid}`)

      console.log(`Mounted at ${mp} (PID ${fuseProc.pid})`)
    })

  program
    .command('unmount')
    .description('Unmount CRM filesystem')
    .argument('[mountpoint]', 'Mount point')
    .action(async (mountpoint?: string) => {
      const { config } = await getCtx()
      const mp = mountpoint || config.mount.default_path

      // Kill FUSE helper and daemon processes first (even if already unmounted)
      const pidFile = join(homedir(), '.crm', `mount-${slugify(mp)}.pid`)
      if (existsSync(pidFile)) {
        const pids = readFileSync(pidFile, 'utf-8').trim().split('\n')
        for (const pid of pids) {
          try {
            process.kill(Number(pid))
          } catch {
            // already dead
          }
        }
        unlinkSync(pidFile)
      }

      // Unmount — on macOS use umount directly (fusermount is Linux-only)
      if (process.platform === 'darwin') {
        spawnSync('umount', [mp], { stdio: ['pipe', 'pipe', 'pipe'] })
      } else {
        const result = spawnSync('fusermount', ['-u', mp], {
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        if (result.status !== 0) {
          spawnSync('umount', [mp], { stdio: ['pipe', 'pipe', 'pipe'] })
        }
      }

      console.log(`Unmounted ${mp}`)
    })

  program
    .command('export-fs')
    .description('Export CRM data as static filesystem tree')
    .argument('<dir>', 'Output directory')
    .action(async (dir) => {
      const { db, config } = await getCtx()
      await generateFS(db, config, dir)
      console.log(`Exported to ${dir}`)
    })
}
