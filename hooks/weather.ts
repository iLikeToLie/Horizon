// What the band measures besides the cache: the context and its weather, a bar
// per recent prompt, the 5-hour and 7-day limits against the time elapsed, the
// session cost and the last prompt's share, and the subagents running.
// After Token Weather Usage by Eric Cologni (github.com/augiefra/claude-mods,
// Apache-2.0), itself after Anthropic's Token Weather example. Rewritten in
// TypeScript, trimmed to what this band draws. Pure except where `$` is passed.
import type { EngineInterface, SessionRateLimit } from 'claude-code'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export type Reading = { tokens: number; window: number; percent: number }
export type Weather = { id: string; icon: string; word: string; color: string }

const HISTORY = 12
const TURN_BARS = 6
const BARS = '▁▂▃▄▅▆▇█'

// Single-column symbols, no emoji: they line up in every font.
const FORECAST: Array<Weather & { upTo: number }> = [
  { upTo: 25, id: 'clear', icon: '☀', word: 'clear', color: '#e8c35a' },
  { upTo: 50, id: 'cloudy', icon: '☁', word: 'cloudy', color: '#a9b4bf' },
  { upTo: 75, id: 'showers', icon: '☂', word: 'showers', color: '#6aaabd' },
  { upTo: 90, id: 'storm', icon: '☇', word: 'storm', color: '#b48ad6' },
  { upTo: Infinity, id: 'compact', icon: '↯', word: 'compact soon', color: '#e06c5a' },
]

const LAST = FORECAST[FORECAST.length - 1] as Weather
export const forecastFor = (percent: number): Weather => FORECAST.find(f => percent < f.upTo) ?? LAST

const WEEK = 7 * DAY
const SPANS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: WEEK }
const ORDER = ['five_hour', 'seven_day', 'spend_limit']
const PACE_ALERT = 15
const USED_ALERT = 90
const OUT_MIN_ELAPSED = DAY
const OUT_MIN_USED = 15

export type Tone = 'calm' | 'fast' | 'alert'
export type Gauge = {
  kind: string
  left: number
  used: number
  /** Share of the window's time elapsed, 0 to 100; null without a reset time or a known span. */
  elapsed: number | null
  /** Points used ahead of the clock: above 0 is faster than time passes. */
  pace: number
  tone: Tone
  reset: string
  /** When the 7-day limit runs out at this week's pace, if before its reset. */
  out: string | null
  outSoon: boolean
}

export type Agents = { running: number; total: number; names: string[] }

export type Weathers = {
  readings: Reading[]
  limits: SessionRateLimit[]
  cost: number | null
  lastPrompt: number | null
  lastPrompt5h: number | null
  agents: Agents
}

// The band's figures, one set per loaded module.
export const w: Weathers & { base: number | null; base5h: number | null; reset5h: number | null; seen: Set<string> } = {
  readings: [], limits: [], cost: null, lastPrompt: null, lastPrompt5h: null,
  agents: { running: 0, total: 0, names: [] },
  base: null, base5h: null, reset5h: null, seen: new Set(),
}

export function resetWeather() {
  w.readings = []
  w.lastPrompt = null
  w.lastPrompt5h = null
  w.base = w.cost
  w.agents = { running: 0, total: 0, names: [] }
  w.seen = new Set()
}

export function pushReading(context: { tokens?: number; window: number; percent?: number } | undefined) {
  if (!context || !context.window) return
  const tokens = context.tokens ?? 0
  const percent = Math.round(context.percent ?? (tokens / context.window) * 100)
  // The start reading is 0 before the first answer: dropped once a real one arrives.
  w.readings = w.readings.filter(r => r.tokens > 0)
  const last = w.readings[w.readings.length - 1]
  if (last && last.tokens === tokens && tokens > 0) return
  w.readings.push({ tokens, window: context.window, percent })
  if (w.readings.length > HISTORY) w.readings = w.readings.slice(-HISTORY)
}

export const lastReading = (): Reading | null => w.readings[w.readings.length - 1] ?? null

/** Tokens each recent prompt added, oldest first; a compaction counts as 0. */
export function turnDeltas(): number[] {
  const d: number[] = []
  const r = w.readings
  for (let i = 1; i < r.length; i++) d.push(Math.max(0, (r[i]?.tokens ?? 0) - (r[i - 1]?.tokens ?? 0)))
  return d.slice(-TURN_BARS)
}

/** One glyph per recent prompt, the heaviest at full height: `past` dim, `now` in the weather's tint. */
export function sparkline(): { past: string; now: string } {
  const d = turnDeltas()
  if (d.length === 0) return { past: '', now: '' }
  const top = Math.max(...d, 1)
  const g = d.map(x => BARS[Math.round((x / top) * (BARS.length - 1))])
  const now = g.pop() ?? ''
  return { past: g.join(''), now }
}

export function trend(): string {
  if (w.readings.length < 2) return ''
  const a = w.readings[w.readings.length - 2]?.tokens ?? 0
  const b = w.readings[w.readings.length - 1]?.tokens ?? 0
  return b > a ? `▲+${short(b - a)}` : b < a ? `▼−${short(a - b)}` : '='
}

/** 1.2M, 107k, 98.3k, 950. */
export function short(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 100_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

export function duration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / MINUTE))
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h}h${String(mins % 60).padStart(2, '0')}`
  return `${Math.floor(h / 24)}d${h % 24}h`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
function dayPart(ms: number): string {
  const d = new Date(ms)
  const h = d.getHours()
  // The hours after midnight belong to the day before ("Fri night").
  if (h < 5) return `${DAYS[(d.getDay() + 6) % 7]} night`
  const part = h < 12 ? 'morning' : h < 18 ? 'afternoon' : h < 22 ? 'evening' : 'night'
  return `${DAYS[d.getDay()]} ${part}`
}

export function sortLimits(list: readonly SessionRateLimit[]): SessionRateLimit[] {
  const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length)
  return [...list].map(l => ({ ...l })).sort((a, b) => rank(a.kind) - rank(b.kind))
}

export function gaugeOf(limit: SessionRateLimit, now: number): Gauge {
  const used = Math.max(0, limit.percentUsed)
  const left = Math.max(0, Math.round((100 - used) * 10) / 10)
  const resetMs = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  const span = SPANS[limit.kind]
  const until = Number.isFinite(resetMs) ? Math.max(0, resetMs - now) : null
  const elapsed = span && until !== null ? Math.min(100, Math.max(0, ((span - until) / span) * 100)) : null
  const pace = elapsed === null ? 0 : used - elapsed
  const tone: Tone = used >= USED_ALERT || pace > PACE_ALERT ? 'alert' : pace > 0 ? 'fast' : 'calm'
  const reset = until === null ? '' : until <= 0 ? 'resetting' : duration(until)
  let out: string | null = null
  let outSoon = false
  // The week's pace decides when the 7-day limit runs out, as Claude's usage page does.
  if (limit.kind === 'seven_day' && Number.isFinite(resetMs)) {
    const start = resetMs - WEEK
    if (now - start >= OUT_MIN_ELAPSED && used >= OUT_MIN_USED && used < 100) {
      const at = now + (100 - used) / (used / (now - start))
      if (at < resetMs) {
        out = dayPart(at)
        outSoon = at - now < DAY
      }
    }
  }
  return { kind: limit.kind, left, used, elapsed, pace, tone, reset, out, outSoon }
}

const fiveHourOf = (list: readonly SessionRateLimit[]) => list.find(l => l.kind === 'five_hour')?.percentUsed ?? null
const fiveHourReset = (list: readonly SessionRateLimit[]) => {
  const ms = Date.parse(list.find(l => l.kind === 'five_hour')?.resetsAt ?? '')
  return Number.isFinite(ms) ? ms : null
}

/** At session start: the first readings, and the bases the last prompt's share is measured from. */
export async function seedWeather($: EngineInterface) {
  const u = await $.session.usage()
  pushReading(u.context)
  if (u.rateLimits.length) w.limits = sortLimits(u.rateLimits)
  w.cost = u.cost?.usd ?? null
  w.base = w.cost
  w.base5h = fiveHourOf(u.rateLimits)
  w.reset5h = fiveHourReset(u.rateLimits)
  await refreshAgents($)
}

/** After each main turn: the context, the cost and what this prompt added, in dollars and in 5-hour points. */
export async function measureTurn($: EngineInterface) {
  const u = await $.session.usage()
  pushReading(u.context)
  if (u.rateLimits.length) w.limits = sortLimits(u.rateLimits)
  if (u.cost) {
    w.cost = u.cost.usd
    if (w.base !== null && w.cost >= w.base) w.lastPrompt = w.cost - w.base
    w.base = w.cost
  }
  const now5h = fiveHourOf(u.rateLimits)
  if (now5h !== null) {
    const reset = fiveHourReset(u.rateLimits)
    // A window that reset in between gives no share.
    const same = w.reset5h === null || reset === null || Math.abs(reset - w.reset5h) < MINUTE
    w.lastPrompt5h = w.base5h !== null && same && now5h >= w.base5h ? Math.round((now5h - w.base5h) * 10) / 10 : null
    w.base5h = now5h
    w.reset5h = reset
  }
}

/** The subagents running now and how many this thread has run; true when the count changed. */
export async function refreshAgents($: EngineInterface): Promise<boolean> {
  let list
  try {
    list = await $.agent.list()
  } catch {
    return false
  }
  const running = list.filter(a => a.status === 'running' || a.status === 'pending' || a.status === 'waiting')
  for (const a of list) w.seen.add(a.id)
  const next: Agents = { running: running.length, total: w.seen.size, names: running.map(a => a.description || a.type).filter(Boolean) }
  const changed = next.running !== w.agents.running || next.total !== w.agents.total
  w.agents = next
  return changed
}
