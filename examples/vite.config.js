// The example host: serves STomp's dist at /stomp/, STicks' static files at
// /sticks/, a wisp relay at /wisp/, and the page in examples/basic.
import { cpSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logging, server as wisp } from '@mercuryworkshop/wisp-js/server'
import { defineConfig } from 'vite'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, 'basic')
const { stompPath } = require('@sysce/stomp/path')
const { sticksPath } = require('../lib/index.cjs')

logging.set_level(logging.WARN)

function host() {
  const upgrade = (request, socket, head) => {
    if (request.url?.startsWith('/wisp/')) wisp.routeRequest(request, socket, head)
  }
  return {
    name: 'sticks-example-host',
    configResolved() {
      for (const [name, source] of [
        ['stomp', stompPath],
        ['sticks', sticksPath],
      ]) {
        const target = join(root, 'public', name)
        rmSync(target, { recursive: true, force: true })
        cpSync(source, target, { recursive: true, filter: (file) => !/(\.map|[\\/]types)$/.test(file) })
      }
    },
    configureServer(server) {
      server.httpServer?.on('upgrade', upgrade)
    },
    configurePreviewServer(server) {
      server.httpServer?.on('upgrade', upgrade)
    },
  }
}

export default defineConfig({
  root,
  plugins: [host()],
  resolve: { alias: { sticks: resolve(here, '../src/index.ts') } },
  build: { target: 'es2022', outDir: join(here, 'dist'), emptyOutDir: true },
})
