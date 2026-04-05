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

      if (!existsSync(helperPath)) {
        // Try to compile it
        const srcPath = join(import.meta.dir, '..', 'fuse-helper.c')
        if (!existsSync(srcPath)) {
          die(
            'Error: FUSE helper not found. Install FUSE dependencies and rebuild, or use `crm export-fs` instead.',
          )
        }
        ensureDir(join(homedir(), '.crm', 'bin'))
        const compile = spawnSync(
          'gcc',
          [
            '-o',
            helperPath,
            srcPath,
            ...(() => {
              const pkgConfig = spawnSync('pkg-config', [
                '--cflags',
                '--libs',
                'fuse3',
              ])
              return pkgConfig.stdout
                ? pkgConfig.stdout.toString().trim().split(/\s+/)
                : ['-lfuse3', '-lpthread']
            })(),
          ],
          { stdio: ['pipe', 'pipe', 'pipe'] },
        )
        if (compile.status !== 0) {
          die(
            `Error: Failed to compile FUSE helper. Ensure libfuse3-dev is installed.\n${compile.stderr?.toString() || ''}`,
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
      fuseProc.unref()

      // Wait briefly for mount to succeed
      await new Promise((resolve) => setTimeout(resolve, 500))

      if (fuseProc.exitCode !== null) {
        daemonProc.kill()
        die('Error: FUSE mount failed. Is FUSE available?')
      }

      // Write PID file for unmount
      const pidFile = join(homedir(), '.crm', `mount-${slugify(mp)}.pid`)
      writeFileSync(pidFile, `${fuseProc.pid}\n${daemonProc.pid}`)

      console.log(`Mounted at ${mp} (PID ${fuseProc.pid})`)
    })

  program
    .command('unmount')
    .description('Unmount CRM filesystem')
    .argument('<mountpoint>', 'Mount point')
    .action((mountpoint: string) => {
      const result = spawnSync('fusermount', ['-u', mountpoint], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      if (result.status !== 0) {
        // Try umount as fallback
        const umount = spawnSync('umount', [mountpoint], {
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        if (umount.status !== 0) {
          die(`Error: Failed to unmount ${mountpoint}`)
        }
      }

      // Kill daemon process if PID file exists
      const pidFile = join(
        homedir(),
        '.crm',
        `mount-${slugify(mountpoint)}.pid`,
      )
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
