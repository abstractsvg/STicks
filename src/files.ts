export const FILE_CACHE = 'sticks-files'

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
}

export function mimeOf(path: string) {
  return TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
}

/** Where an extension's files live: `${origin}${base}ext/<id>/<path>`, served by static/sw.js. */
export class FileStore {
  readonly base: string

  constructor(base: string) {
    this.base = base
  }

  url(extId: string, path = '') {
    const clean = path.replace(/^\/+/, '')
    return new URL(`${this.base}ext/${extId}/${clean.split('/').map(encodeURIComponent).join('/')}`, location.origin).href
  }

  async write(extId: string, files: Map<string, Uint8Array>) {
    const cache = await caches.open(FILE_CACHE)
    await Promise.all(
      [...files].map(([path, data]) =>
        cache.put(
          this.url(extId, path),
          new Response(data as BodyInit, { headers: { 'content-type': mimeOf(path), 'cache-control': 'no-cache' } }),
        ),
      ),
    )
  }

  async read(extId: string, path: string): Promise<Response | null> {
    const cache = await caches.open(FILE_CACHE)
    return (await cache.match(this.url(extId, path))) ?? null
  }

  async text(extId: string, path: string) {
    const response = await this.read(extId, path)
    return response ? response.text() : null
  }

  async remove(extId: string) {
    const cache = await caches.open(FILE_CACHE)
    const prefix = this.url(extId)
    for (const request of await cache.keys()) if (request.url.startsWith(prefix)) await cache.delete(request)
  }
}
