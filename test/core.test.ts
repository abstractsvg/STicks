import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseCrx } from '../src/crx.ts'
import { compileRule, compileRules } from '../src/dnr.ts'
import type { DnrRule } from '../src/context.ts'
import { getMessage, normalizeMessages, parseLooseJson, parseManifest } from '../src/manifest.ts'
import { matchesPattern, scriptMatches } from '../src/match.ts'
import { readZip } from '../src/zip.ts'

const fixtures = join(import.meta.dirname, 'fixtures')
const crxFiles = existsSync(fixtures) ? readdirSync(fixtures).filter((name) => name.endsWith('.crx')) : []

test('loose JSON: comments, trailing commas, BOM, commas inside strings', () => {
  const value = parseLooseJson('﻿{ // note\n "a": "x,}", /* block */ "b": [1, 2,], }') as { a: string; b: number[] }
  assert.equal(value.a, 'x,}')
  assert.deepEqual(value.b, [1, 2])
})

test('match patterns', () => {
  assert.ok(matchesPattern('*://*.discord.com/*', 'https://discord.com/app'))
  assert.ok(matchesPattern('*://*.discord.com/*', 'https://canary.discord.com/channels/1'))
  assert.ok(!matchesPattern('*://*.discord.com/*', 'https://evil.com/discord.com'))
  assert.ok(!matchesPattern('*://*.discord.com/*', 'https://notdiscord.com/'))
  assert.ok(matchesPattern('<all_urls>', 'https://example.com/'))
  assert.ok(matchesPattern('https://example.com/path*', 'https://example.com/path/to?x=1'))
  assert.ok(!matchesPattern('https://example.com/path*', 'http://example.com/path'))
  assert.ok(scriptMatches({ matches: ['<all_urls>'], exclude_matches: ['*://*.example.com/*'] }, 'https://a.org/'))
  assert.ok(!scriptMatches({ matches: ['<all_urls>'], exclude_matches: ['*://*.example.com/*'] }, 'https://www.example.com/'))
  assert.ok(!scriptMatches({ matches: ['<all_urls>'], include_globs: ['*/watch*'] }, 'https://youtube.com/feed'))
})

test('i18n messages and placeholders', () => {
  const catalog = normalizeMessages({
    Greeting: { message: 'Hello $NAME$, you have $1 new', placeholders: { name: { content: '$2' } } },
  })
  assert.equal(getMessage([catalog], 'greeting', ['3', 'Ada'], {}), 'Hello Ada, you have 3 new')
  assert.equal(getMessage([catalog], '@@extension_id', undefined, { '@@extension_id': 'abc' }), 'abc')
  assert.equal(getMessage([catalog], 'missing', undefined, {}), '')
})

test('DNR rules compile to URLPatterns that match what Chrome would', () => {
  const block = compileRule({ id: 1, condition: { urlFilter: '||ads.example.com^' }, action: { type: 'block' } })!
  const pattern = new URLPattern(block[0].match.url!)
  assert.ok(pattern.test('https://ads.example.com/x.js'))
  assert.ok(pattern.test('https://cdn.ads.example.com/y'))
  assert.ok(!pattern.test('https://notads.example.com/'))
  assert.ok(!block[0].match.destination!.includes('document'), 'main_frame is excluded by default')

  const domains = compileRule({ id: 2, condition: { requestDomains: ['tracker.net', 'my-ads.com'], resourceTypes: ['script'] }, action: { type: 'block' } })!
  const domainPattern = new URLPattern(domains[0].match.url!)
  assert.ok(domainPattern.test('https://x.tracker.net/a'))
  assert.ok(domainPattern.test('https://my-ads.com/b'))
  assert.ok(!domainPattern.test('https://tracker.network/'))
  assert.deepEqual(domains[0].match.destination, ['script'])

  assert.equal(compileRule({ id: 3, condition: { regexFilter: '.*' }, action: { type: 'block' } }), null)
  const headers = compileRule({ id: 4, condition: {}, action: { type: 'modifyHeaders', responseHeaders: [{ header: 'x-frame-options', operation: 'remove' }] } })!
  assert.deepEqual(headers[0].action, { requestHeaders: undefined, responseHeaders: { 'x-frame-options': null } })

  const { rules, stats } = compileRules(
    [
      { id: 5, priority: 1, condition: { urlFilter: '||a.com^' }, action: { type: 'block' } },
      { id: 6, priority: 2, condition: { urlFilter: '||a.com^' }, action: { type: 'allow' } },
    ],
    10,
  )
  assert.deepEqual(rules[0].action, {}, 'higher priority allow comes first')
  assert.equal(stats.compiled, 2)
})

for (const file of crxFiles) {
  test(`real extension ${file}`, async () => {
    const parts = parseCrx(readFileSync(join(fixtures, file)))
    assert.equal(parts.crxId, file.replace('.crx', ''), 'CRX3 header id matches the Web Store id')
    const entries = readZip(parts.zip)
    const manifestEntry = entries.find((entry) => entry.name === 'manifest.json')
    assert.ok(manifestEntry, 'has manifest.json')
    const manifest = parseManifest(new TextDecoder().decode(await manifestEntry.read()))
    assert.ok(manifest.name)
    for (const resource of manifest.declarative_net_request?.rule_resources ?? []) {
      const entry = entries.find((candidate) => candidate.name === resource.path.replace(/^\//, ''))
      assert.ok(entry, `ruleset ${resource.path} exists`)
      const ruleset = JSON.parse(new TextDecoder().decode(await entry.read())) as DnrRule[]
      const { rules, stats } = compileRules(ruleset, 100_000)
      for (const rule of rules) assert.doesNotThrow(() => new URLPattern(rule.match.url!), rule.match.url)
      console.log(`  ${manifest.name} ${resource.id}: ${stats.compiled}/${stats.total} rules compiled into ${rules.length} patterns`)
    }
  })
}
