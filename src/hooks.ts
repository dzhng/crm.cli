import { spawnSync } from 'node:child_process'

import type { CRMConfig } from './config.ts'

export function runHook(
  config: CRMConfig,
  hookName: string,
  data: any,
): boolean {
  const hookCmd = config.hooks[hookName]
  if (!hookCmd) {
    return true // no hook = success
  }

  const jsonData = JSON.stringify(data)
  const result = spawnSync(hookCmd, {
    shell: true,
    input: jsonData,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000,
  })

  return result.status === 0
}
