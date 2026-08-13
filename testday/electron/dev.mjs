import { spawn } from 'node:child_process'
import { context } from 'esbuild'
import { createServer } from 'vite'
import electronBinary from 'electron'
import { common, targets } from './build.mjs'

/**
 * Development runner: Vite for the interface, esbuild watching the main process,
 * and Electron pointed at the dev server. Deliberately a plain script rather
 * than a plugin, so there is nothing between the three processes to debug when
 * a test day is waiting.
 */

const server = await createServer({ server: { port: 5173, strictPort: true } })
await server.listen()
const url = server.resolvedUrls?.local?.[0] ?? 'http://localhost:5173'
server.printUrls()

let child = null
let restarting = false

function startElectron() {
  child = spawn(electronBinary, ['.'], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: url, ELECTRON_ENABLE_LOGGING: '1' },
  })
  child.on('exit', (code) => {
    child = null
    if (restarting) return
    void shutdown(code ?? 0)
  })
}

async function restart() {
  if (!child) {
    startElectron()
    return
  }
  restarting = true
  child.kill()
  await new Promise((resolve) => setTimeout(resolve, 150))
  restarting = false
  startElectron()
}

// Rebuild the main process on change and bounce Electron, so edits to the
// recorder are picked up without stopping the whole stack.
const contexts = await Promise.all(
  targets.map((target) =>
    context({
      ...common,
      ...target,
      logLevel: 'warning',
      plugins: [
        {
          name: 'restart-electron',
          setup(build) {
            let first = true
            build.onEnd((result) => {
              if (result.errors.length > 0) return
              if (first) {
                first = false
                return
              }
              console.log('[testday] main process rebuilt, restarting Electron')
              void restart()
            })
          },
        },
      ],
    }),
  ),
)
await Promise.all(contexts.map((ctx) => ctx.watch()))

startElectron()

async function shutdown(code) {
  for (const ctx of contexts) await ctx.dispose()
  await server.close()
  process.exit(code)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restarting = true
    child?.kill()
    void shutdown(0)
  })
}
