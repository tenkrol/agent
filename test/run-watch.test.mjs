/** Регрессия PLA-53: пустой интервал сторожа не является ошибкой systemd. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

const execFileAsync = promisify(execFile)
const script = path.resolve('deploy/agent-run-watch')

test('agent-run-watch succeeds and advances its marker when no task finished', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-run-watch-'))
  const bin = path.join(dir, 'bin')
  const marker = path.join(dir, 'run-watch.marker')
  try {
    await fs.mkdir(bin)
    await fs.writeFile(marker, '1\n')
    await fs.writeFile(path.join(bin, 'journalctl'), '#!/bin/sh\nprintf "%s\\n" "обычная строка журнала"\n')
    await fs.writeFile(path.join(bin, 'flock'), '#!/bin/sh\nexit 0\n')
    await fs.chmod(path.join(bin, 'journalctl'), 0o755)
    await fs.chmod(path.join(bin, 'flock'), 0o755)

    await execFileAsync('bash', [script], {
      env: {
        ...process.env,
        STATE_ROOT: dir,
        AGENT_ENV: path.join(dir, 'missing.env'),
        PATH: `${bin}:${process.env.PATH}`,
      },
    })

    assert.ok(Number((await fs.readFile(marker, 'utf8')).trim()) > 1)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
