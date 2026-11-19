import type { ContentRegistration, Extension } from './context.ts'
import type { DocumentRecord, Sticks } from './sticks.ts'

const clean = (path: string) => path.replace(/^\/+/, '')

/**
 * Runs code in a proxied document. The realm's own Function is STomp's
 * wrapped constructor, so the code is rewritten like any script the page
 * makes (location, top, cookies... read as the real site). ISOLATED code gets
 * its extension's chrome as a parameter; page scripts never see it.
 */
export function runInWorld(s: Sticks, record: DocumentRecord, ext: Extension, body: string, world: 'ISOLATED' | 'MAIN', wantResult: boolean): unknown {
  const win = record.window
  try {
    if (world === 'MAIN') return new win.Function(body).call(win)
    const ctx = s.contentContext(record, ext)
    return new win.Function('chrome', body).call(win, s.chromeFor(ctx))
  } catch (error) {
    console.error(`[sticks] ${ext.manifest.name}: content script failed in ${record.url}`, error)
    if (wantResult) throw error
    return undefined
  }
}

/** A <style> in the document, added as soon as it has a root element. */
export function injectStyle(record: DocumentRecord, key: string, css: string) {
  const existing = record.styles.get(key)
  if (existing) {
    existing.textContent = css
    return
  }
  const doc = record.window.document
  const style = doc.createElement('style')
  style.setAttribute('data-sticks', '')
  style.textContent = css
  record.styles.set(key, style)
  const attach = () => {
    const parent = doc.head ?? doc.documentElement
    if (!parent) return false
    parent.append(style)
    return true
  }
  if (attach()) return
  const observer = new record.window.MutationObserver(() => {
    if (attach()) observer.disconnect()
  })
  observer.observe(doc, { childList: true, subtree: true })
}

/** Runs one content_scripts entry at its run_at point. */
export function scheduleRegistration(s: Sticks, record: DocumentRecord, ext: Extension, registration: ContentRegistration) {
  const doc = record.window.document
  const run = () => {
    if (s.documents.get(record.window) !== record || !ext.enabled) return
    for (const path of registration.css) injectStyle(record, `${ext.id}:css:${clean(path)}`, ext.sources.get(clean(path)) ?? '')
    if (!registration.js.length) return
    const body = registration.js.map((path) => ext.sources.get(clean(path)) ?? '').join('\n;\n')
    const sourceUrl = s.extensionUrl(ext.id, clean(registration.js[0]))
    runInWorld(s, record, ext, `${body}\n//# sourceURL=${sourceUrl}`, registration.world, false)
  }
  const later = () => setTimeout(run, 0)
  switch (registration.run_at) {
    case 'document_start':
      run()
      break
    case 'document_end':
      if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', run, { once: true })
      else run()
      break
    default:
      if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', later, { once: true })
      else later()
  }
}
