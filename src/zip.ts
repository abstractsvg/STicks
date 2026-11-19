const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

export interface ZipEntry {
  name: string
  read(): Promise<Uint8Array>
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Lists the files in a ZIP archive (no ZIP64, no encryption: what extensions use). */
export function readZip(buffer: ArrayBuffer | Uint8Array): ZipEntry[] {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === EOCD) {
      end = at
      break
    }
  }
  if (end < 0) throw new Error('not a zip archive')
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  const decoder = new TextDecoder()
  const entries: ZipEntry[] = []
  for (let index = 0; index < count; index++) {
    if (view.getUint32(at, true) !== CENTRAL) throw new Error('corrupt zip central directory')
    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    const size = view.getUint32(at + 20, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const local = view.getUint32(at + 42, true)
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))
    at += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue
    if (flags & 1) throw new Error(`${name} is encrypted`)
    if (size === 0xffffffff) throw new Error('zip64 archives are not supported')
    entries.push({
      name,
      read: async () => {
        if (view.getUint32(local, true) !== LOCAL) throw new Error(`corrupt zip entry ${name}`)
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
        const data = bytes.subarray(start, start + size)
        if (method === 0) return data.slice()
        if (method === 8) return inflate(data)
        throw new Error(`${name} uses unsupported compression ${method}`)
      },
    })
  }
  return entries
}
