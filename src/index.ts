export { GLOBAL, Sticks, type ProxyTransportLike, type SticksOptions } from './sticks.ts'
export { compileRule, compileRules, type CompileStats } from './dnr.ts'
export { matchesPattern, scriptMatches } from './match.ts'
export { idFromKey, parseCrx } from './crx.ts'
export { readZip } from './zip.ts'
export type {
  ExtensionSummary,
  Manifest,
  NotificationOptions,
  SticksHost,
  StompControllerLike,
  StompHookContext,
  StompNavigateInfo,
  StompRequestInfo,
  StompRule,
  TabInfo,
} from './types.ts'
