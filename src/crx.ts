const MAGIC = 0x34327243

export interface CrxParts {
  zip: Uint8Array
  /** the id the CRX3 header declares (32 letters a-p) */
  crxId: string | null
  /** the CRX2 public key */
  publicKey: Uint8Array | null
}

/** Chrome's id alphabet: the first 16 bytes of a hash as hex, mapped 0-f to a-p. */
export function idFromBytes(bytes: Uint8Array) {
  let id = ''
  for (const byte of bytes.subarray(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))
  }
  return id
}

export async function idFromKey(key: Uint8Array) {
  return idFromBytes(new Uint8Array(await crypto.subtle.digest('SHA-256', key as BufferSource)))
}

export async function idFromText(text: string) {
  return idFromKey(new TextEncoder().encode(text))
}

function readVarint(bytes: Uint8Array, at: number): [number, number] {
  let value = 0
  let shift = 0
  for (;;) {
    if (at >= bytes.length) throw new Error('truncated crx header')
    const byte = bytes[at++]
    value += (byte & 0x7f) * 2 ** shift
    if (!(byte & 0x80)) return [value, at]
    shift += 7
  }
}

function protobufField(bytes: Uint8Array, field: number): Uint8Array | null {
  let at = 0
  while (at < bytes.length) {
    const [key, next] = readVarint(bytes, at)
    at = next
    const type = key & 7
    const number = Math.floor(key / 8)
    if (type === 2) {
      const [length, start] = readVarint(bytes, at)
      if (number === field) return bytes.subarray(start, start + length)
      at = start + length
    } else if (type === 0) {
      at = readVarint(bytes, at)[1]
    } else if (type === 5) {
      at += 4
    } else if (type === 1) {
      at += 8
    } else {
      return null
    }
  }
  return null
}

/** Splits a .crx into its zip; a plain .zip passes through. */
export function parseCrx(buffer: ArrayBuffer | Uint8Array): CrxParts {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 16 || view.getUint32(0, true) !== MAGIC) return { zip: bytes, crxId: null, publicKey: null }
  const version = view.getUint32(4, true)
  if (version === 2) {
    const keyLength = view.getUint32(8, true)
    const signatureLength = view.getUint32(12, true)
    const keyStart = 16
    return {
      zip: bytes.subarray(keyStart + keyLength + signatureLength),
      crxId: null,
      publicKey: bytes.subarray(keyStart, keyStart + keyLength),
    }
  }
  if (version === 3) {
    const headerLength = view.getUint32(8, true)
    const header = bytes.subarray(12, 12 + headerLength)
    let crxId: string | null = null
    try {
      const signed = protobufField(header, 10000)
      const id = signed && protobufField(signed, 1)
      if (id && id.length === 16) crxId = idFromBytes(id)
    } catch {
      crxId = null
    }
    return { zip: bytes.subarray(12 + headerLength), crxId, publicKey: null }
  }
  throw new Error(`unsupported crx version ${version}`)
}
