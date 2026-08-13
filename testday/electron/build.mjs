import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

/**
 * Bundles the main process and preload. Output is CommonJS with a `.cjs`
 * extension because the package is `"type": "module"`, and a preload script
 * running in a sandboxed renderer has to be CommonJS.
 */
export const targets = [
  { entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs' },
  { entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs' },
]

export const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // Provided by the runtime, never bundled.
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
}

// Compared as URLs, not strings: the project path contains spaces, which
// `import.meta.url` percent-encodes and a raw `file://` prefix does not.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await Promise.all(targets.map((target) => build({ ...common, ...target })))
}
