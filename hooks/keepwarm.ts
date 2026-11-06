// The cache engine: keepwarm pings, the cold-send guard and cold-write scoring.
// Ported from Cache Tax by Karan Bansal (github.com/karanb192/cache-tax, MIT),
// without its own band (the horizon band draws this state) and with a
// handoff note added: prepared over the still-warm cache a few minutes before
// it lapses, so a cold comeback can /clear and carry on instead of paying the
// rewrite.
import type { EngineInterface } from 'claude-code'

export const TTL_MS = 60 * 60 * 1000
export const PING_AFTER_MS = 50 * 60 * 1000
export const MIN_PING_MS = 60 * 1000
export const MAX_RETRIES = 3
export const AUTO_WARM_MS = 3 * 60 * 60 * 1000
export const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000
export const BIG_TOKENS = 50000
export const PING_PROMPT = 'Reply with the single word: warm'
/** The handoff note is prepared between these idle times: late enough that the person has likely stepped away, early enough that the cache still serves the read. */
export const HANDOFF_FROM_MS = 50 * 60 * 1000
export const HANDOFF_UNTIL_MS = 57 * 60 * 1000
export const HANDOFF_PROMPT = 'You have no tools; answer straight away. The prompt cache for this conversation is about to expire. ' +
  'Write a handoff note (at most 300 words, Markdown) that lets a fresh conversation with no memory of this one carry on the work: ' +
  'the goal, what is done, what is in progress, the decisions made and why, the files involved by path, and the next concrete steps. ' +
  'Start with the line "Continuing from a previous conversation:". Output only the note.'
export const KEY_DEADLINE = 'deadline'
export const KEY_EVERY = 'every'
export const KEY_GUARD = 'guard'
export const KEY_ALWAYS = 'always'

// Prompts no person sent, so nobody could send them again after a refusal. Every
// other origin, including sdk, unclassified and the owner's own Slack or channel
// messages, may carry a person's words and keeps the guard.
export const UNATTENDED = new Set(['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'coordinator', 'observer', 'observer-activity'])

export const LONG_PROMPT_TOKENS = 100000

// $ per million tokens, [cache read, 1h cache write, output], list prices October 2026.
// More specific families first: a model id takes the first row it matches.
export const PRICES: Array<[string | RegExp, number, number, number]> = [
  ['fable-5-1', 0.25, 20, 50],
  ['mythos-5-1', 0.25, 20, 50],
  ['fable-5', 1, 20, 50],
  ['mythos-5', 1, 20, 50],
  ['opus-5-5', 0.2, 8, 20],
  ['opus-5', 0.5, 10, 25],
  // Opus 4 and 4.1 in every spelling (claude-opus-4-1-20250805, claude-opus-4@20250514, the -0 and -1 aliases), never Opus 4.5 and later.
  [/opus-4(?:-[01])?(?:$|[^-\d]|-20\d{6})/, 1.5, 30, 75],
  ['opus-4', 0.5, 10, 25],
  ['sonnet-5-5', 0.1, 4, 10],
  ['sonnet-5', 0.2, 4, 10],
  ['sonnet', 0.3, 6, 15],
  ['haiku-5-5', 0.01, 0.2, 0.5],
  ['3-5-haiku', 0.08, 1.6, 4],
  ['haiku-3-5', 0.08, 1.6, 4],
  ['haiku', 0.1, 2, 5],
]

// A request whose prompt, cache reads and writes included, is over 100k tokens pays these instead.
export const LONG_PRICES: Array<[string, number, number, number]> = [
  ['haiku-5-5', 0.05, 1, 2.5],
]

type PingRecord = { at: number; read: number; write: number; usd: number | null; warm: boolean }
type Miss = { at: number; tokens: number; usd: number | null }
type GuardMode = 'refuse' | 'warn'
/** A handoff note: its text, when it was written, what the fork cost, and the main turn it summarizes. */
export type Note = { text: string; at: number; usd: number | null; forTurn: number }

export type State = {
  handoffOn: boolean
  note: Note | null
  /** The last note written in this process, kept after it goes out of date and across /clear, so the band can say one exists and /handoff show can still print it. */
  lastNote: Note | null
  noteFailed: string | null
  turnNo: number
  noteTriedFor: number
  noteWriting: boolean
  handoffAckedAt: number
  hasBand: boolean
  sid: string
  deadline: number
  every: number
  always: boolean
  lastRequestAt: number
  lastModel: string | null
  ctx: number
  compacted: boolean
  resumedAt: number
  transcript: number
  guard: GuardMode
  ackedAt: number
  coldWritePending: boolean
  misses: Miss[]
  pending: { cancel: () => void } | null
  last: PingRecord | null
  stopped: string | null
  waitForTurn: boolean
  retries: number
  retryReason: string
  gen: number
  tick: number
  offs: number
  turnOffs: number | null
  inFlight: boolean
  stepWrites: StepWrites | null
  /** What this turn's cold requests wrote: each read next to nothing from the cache and wrote at least half the context again. */
  coldWrites: StepWrites | null
  steps: number
  endingSid: string
}

/** What this turn's main requests wrote before any compaction it saw, priced per request where the steps reported usage. */
type StepWrites = { tokens: number; usd: number; priced: boolean }

/** [cache read, 1h cache write, output] in $ per million tokens; base input is half the 1h write. */
export function priceOf(model: string | null, promptTokens: number): [number, number, number] | null {
  const m = (model ?? '').toLowerCase().replace(/[\s.]+/g, '-')
  if (promptTokens > LONG_PROMPT_TOKENS) {
    for (const [family, read, write, output] of LONG_PRICES) if (m.includes(family)) return [read, write, output]
  }
  for (const [family, read, write, output] of PRICES) {
    if (typeof family === 'string' ? m.includes(family) : family.test(m)) return [read, write, output]
  }
  return null
}

export function parseDuration(text: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim())
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 * 1000
}

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

export function fmtUsd(usd: number | null): string {
  return usd == null ? 'n/a' : '$' + (usd >= 100 ? usd.toFixed(0) : usd.toFixed(2))
}

export function fmtTok(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

export function coldUsd(s: State): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  return price ? s.ctx * price[1] / 1e6 : null
}

export function warmUsd(s: State): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  return price ? s.ctx * price[0] / 1e6 : null
}

/** Everything a fork bills: the cache read, any cache write, uncached input at the base rate (half the 1h write rate), and the output. */
export function pingUsd(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }, price: [number, number, number]): number {
  return (u.cache_read_input_tokens * price[0] + u.cache_creation_input_tokens * price[1] + u.input_tokens * price[1] / 2 + u.output_tokens * price[2]) / 1e6
}

export function isCold(s: State, now: number): boolean {
  return s.lastRequestAt > 0 && !s.compacted && now - s.lastRequestAt >= TTL_MS
}

export function guardText(s: State, now: number): string {
  const price = priceOf(s.lastModel, s.ctx)
  const rate = price ? `$${price[1]}/MTok` : 'the cache-write rate'
  const warm = warmUsd(s)
  return `the prompt cache went cold ${fmtDuration(now - s.lastRequestAt - TTL_MS)} ago. Sending this re-writes ` +
    `up to ${s.ctx.toLocaleString('en-US')} tokens at ${rate} = ${fmtUsd(coldUsd(s))}` +
    (warm == null ? '' : ` (a warm turn would have cost ${fmtUsd(warm)})`) + '.'
}

export type ResumeFields = {
  source: string
  model?: string
  context_tokens?: number
  seconds_since_last_response?: number
  prompt_cache_likely_expired?: boolean
  estimated_cache_write_usd?: number
}

/** /clear starts a new conversation in the same process; nothing priced before it still exists. */
export function resetForClear(s: State) {
  s.ctx = 0
  s.lastRequestAt = 0
  s.compacted = false
  s.resumedAt = 0
  s.transcript = 0
  s.ackedAt = 0
  s.coldWritePending = false
  s.misses = []
  s.waitForTurn = false
  s.stepWrites = null
  s.coldWrites = null
  s.steps = 0
  s.note = null
  s.noteFailed = null
  s.handoffAckedAt = 0
  outdate(s)
  disarm(s)
}

/** Applies a resumed session's fields to the state; returns the line to log, if any. */
export function seedFromResume(s: State, e: ResumeFields, now: number): string | null {
  if (e.source !== 'resume' && e.source !== 'fork') return null
  if (typeof e.context_tokens === 'number' && e.context_tokens > 0) s.ctx = e.context_tokens
  if (typeof e.seconds_since_last_response === 'number') {
    s.lastRequestAt = now - e.seconds_since_last_response * 1000
    s.resumedAt = 0
  }
  if (typeof e.model === 'string') s.lastModel = e.model
  s.compacted = false
  if (e.prompt_cache_likely_expired !== true || s.ctx < BIG_TOKENS) return null
  const usd = typeof e.estimated_cache_write_usd === 'number' ? fmtUsd(e.estimated_cache_write_usd) : fmtUsd(coldUsd(s))
  return `resuming cold. The first message re-writes ${s.ctx.toLocaleString('en-US')} tokens, about ${usd}. /clear and paste a summary if you only need the conclusions.`
}

/** A transcript resumed without the time of its last response: that response came after its first launch, so an hour after that launch the cache may be cold. */
export function mayBeCold(s: State, now: number): boolean {
  return s.resumedAt > 0 && !s.lastRequestAt && now - s.resumedAt >= TTL_MS
}

/** The line for a resumed session whose last response time never arrived: the cache may be cold, and this is what that would cost. */
export function unknownText(s: State): string {
  const price = priceOf(s.lastModel, s.ctx)
  const rate = price ? `$${price[1]}/MTok` : 'the cache-write rate'
  return `resumed with up to ${s.ctx.toLocaleString('en-US')} tokens of context and no time of its last response, so the cache may be cold. ` +
    `If it is, this message re-writes them at ${rate} = ${fmtUsd(coldUsd(s))}.`
}

/** The conversation was summarized: the next request is the first over the new prefix, and a ping out for the old one is dropped. */
export function markCompacted(s: State) {
  s.compacted = true
  s.transcript = 0
  s.ackedAt = 0
  outdate(s)
}

export function statusText(s: State, now: number): string | undefined {
  if (s.stopped) return `keepwarm stopped: ${s.stopped}`
  if (!s.deadline) return undefined
  const pingText = s.last ? ` · last ping read ${fmtTok(s.last.read)} ${fmtUsd(s.last.usd)}` : ''
  const nextText = !s.lastRequestAt ? ' · waiting for the first turn'
    : s.compacted ? ' · waiting for the first turn after compaction'
    : isCold(s, now) ? ` · cold now, first ping ${fmtDuration(s.every)} after the next turn`
    : s.waitForTurn ? ' · nothing to fork yet, first ping after the next turn'
    : s.retries ? ` · API busy, ping retry ${s.retries} of ${MAX_RETRIES}`
    : ` · ping in ${fmtDuration(s.lastRequestAt + s.every - now)}`
  return `keepwarm ${fmtDuration(s.deadline - now)} left${nextText}${pingText}`
}

export function updateStatus($: EngineInterface, s: State, now: number) {
  if (s.hasBand) $.ui.invalidate('ui.render')
  else $.ui.status(statusText(s, now))
}

/** Cancels the timer. Every new timer is set right after this, so the tick also says the schedule changed. */
export function disarm(s: State) {
  if (s.pending) s.pending.cancel()
  s.pending = null
  s.tick++
}

/** Outdates any ping in flight: /clear, a resume, compaction or stop replaced the state it was sent for. Re-arming or extending the window does not, so a ping out at that moment still counts; a main request outdates it through the request clock. */
export function outdate(s: State) {
  s.gen++
}

// The window and its ping period belong to the session that armed them, so a
// second session, or one resumed from another transcript, never inherits them
// and cannot turn them off. The always switch and the guard mode stay global.
export function deadlineKey(s: State): string {
  return `${KEY_DEADLINE}:${s.sid}`
}

export function everyKey(s: State): string {
  return `${KEY_EVERY}:${s.sid}`
}

/** Clears this session's own dead window and the bare keys a store written before 2.1.1 still holds. Other sessions' keys are never touched: a read followed by a delete cannot be made atomic against their renewal. */
export async function prune($: EngineInterface, s: State, now: number) {
  for (const key of [KEY_DEADLINE, deadlineKey(s)]) {
    const deadline = await $.store.get(key)
    if (deadline === undefined) continue
    if (typeof deadline === 'number' && deadline > now) continue
    await $.store.delete(key)
    await $.store.delete(KEY_EVERY + key.slice(KEY_DEADLINE.length))
  }
}

export async function stop($: EngineInterface, s: State, why: string | null, forgetAlways = false) {
  // Set before any await, so a window being opened at the same moment sees the off and does not write itself back.
  if (forgetAlways) {
    s.always = false
    s.offs++
  }
  s.deadline = 0
  s.every = PING_AFTER_MS
  s.stopped = why
  s.retries = 0
  outdate(s)
  disarm(s)
  await $.store.delete(deadlineKey(s))
  await $.store.delete(everyKey(s))
  if (forgetAlways) await $.store.delete(KEY_ALWAYS)
  updateStatus($, s, await $.clock.now())
}

/** The conversation ended under /clear or an in-process resume. The next one's id cannot be read until the engine has switched, so the state is left unseated. */
export async function endConversation($: EngineInterface, s: State, reason: 'clear' | 'resume') {
  // Claimed before any await: a second end or a classic start for the same conversation finds it already gone, and an
  // end cut short by its budget leaves no timer and no old id behind, only the keys below.
  const keys = [deadlineKey(s), everyKey(s)]
  const ending = s.sid
  resetForClear(s)
  s.sid = ''
  s.endingSid = ending
  // /clear ends the conversation the window was armed for. A resume carries the window on to the next one, under its
  // id: the old id's keys go here, or a /keepwarm off there could never find them and the old session would re-arm them.
  if (reason === 'clear') {
    s.deadline = 0
    s.every = PING_AFTER_MS
    s.stopped = null
    s.retries = 0
  }
  for (const key of keys) await $.store.delete(key)
  if (reason === 'clear') updateStatus($, s, await $.clock.now())
}

/** Reads the session the process runs now: its id, its model and the engine's figures for its context. Returns the time read with them. */
export async function seat($: EngineInterface, s: State, id?: string): Promise<number> {
  s.sid = id ?? await $.session.id()
  s.endingSid = ''
  s.lastModel = await $.session.model()
  const usage = await $.session.usage()
  const now = await $.clock.now()
  if (usage.context.tokens) s.ctx = usage.context.tokens
  // A resumed transcript's last response came somewhere between its first launch and now; only the resume fields say where.
  s.resumedAt = !s.lastRequestAt && usage.context.tokens ? usage.startedAt : 0
  return now
}

/** Seats the state in the conversation that followed a /clear or a resume, once, and arms what always or a window opened meanwhile asks for. */
export async function reseat($: EngineInterface, s: State) {
  if (s.sid) return
  const id = await $.session.id()
  // The host still answers with the conversation being ended: the next one is not there to seat yet, so nothing is
  // seated under the old id, and a window opened meanwhile waits in memory for the id it belongs to.
  if (id === s.endingSid) return
  const now = await seat($, s, id)
  if (s.always) await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
  // A window carried over, or armed while the conversation was ending, is written under this id.
  else if (s.deadline) await startWindow($, s, s.deadline - now, s.every)
  else updateStatus($, s, now)
}

export async function arm($: EngineInterface, s: State) {
  disarm(s)
  s.retries = 0
  if (!s.deadline) return
  const now = await $.clock.now()
  // A timer set while the clock was read, such as a retry, is replaced here, never left running beside this one;
  // from this line to the assignment below nothing awaits.
  disarm(s)
  s.retries = 0
  if (now >= s.deadline) return stop($, s, null)
  // A cold window still needs expiry cleanup, but must not send a model request.
  if (s.lastRequestAt && !s.compacted && !isCold(s, now)) {
    const untilCold = s.lastRequestAt + TTL_MS - now
    // Waiting for a turn sends nothing, but wakes when the cache goes cold so the row says so.
    if (s.waitForTurn) s.pending = $.clock.after(Math.min(s.deadline - now, untilCold), () => { void arm($, s) })
    else {
      const delay = Math.min(s.deadline - now, untilCold, Math.max(1000, s.lastRequestAt + s.every - now))
      s.pending = $.clock.after(delay, () => { void ping($, s) })
    }
  } else {
    s.pending = $.clock.after(s.deadline - now, () => { void arm($, s) })
  }
  updateStatus($, s, now)
}

export async function ping($: EngineInterface, s: State) {
  s.pending = null
  if (!s.deadline) return
  const tick = s.tick
  const now = await $.clock.now()
  // A timer set or cancelled while the clock was read (an extension, a retry, a turn) owns the window now;
  // if that left no timer, a window still open is armed again rather than left without one.
  if (s.tick !== tick) return s.pending || s.inFlight ? undefined : arm($, s)
  // One fork at a time: the one already out re-arms when it settles. Checked after the await, and set
  // below with no await in between, so two timers can never both send.
  if (s.inFlight) return
  if (now >= s.deadline) return arm($, s)
  if (isCold(s, now)) return arm($, s)
  if (s.compacted || s.waitForTurn || !s.lastRequestAt) return arm($, s)
  // A request since this timer was set moved the clock; schedule from it.
  if (now - s.lastRequestAt < s.every - 1000) return arm($, s)
  // A host that slept past a retry's slot must not send it inside the last minute.
  if (s.retries && now >= s.lastRequestAt + TTL_MS - MIN_PING_MS) return stop($, s, s.retryReason + afterRetries(s.retries))
  const gen = s.gen
  const sentAt = s.lastRequestAt
  s.inFlight = true
  const sent = await $.model.fork({ prompt: PING_PROMPT }).then(reply => ({ reply }), (err: unknown) => ({ err }))
  const at = await $.clock.now()
  s.inFlight = false
  // Checked after the last await. A stop, /clear, resume or compaction, or a main request that moved the
  // cache clock, replaced what this fork was sent for: its reply is dropped and the window armed afresh.
  if (gen !== s.gen || s.lastRequestAt !== sentAt) return s.pending ? undefined : arm($, s)
  if ('err' in sent) return stop($, s, `the ping failed, ${sent.err instanceof Error ? sent.err.message : String(sent.err)}`)
  const reply = sent.reply
  if (reply === null) return stop($, s, 'the engine did not send the ping, either the snapshot was cold or the API call failed')
  if (reply.isAnswered === false) {
    // A restarted process has no conversation to fork until its first turn; the window waits for one instead of ending.
    if (reply.reason === 'nothing-to-fork') {
      s.waitForTurn = true
      return arm($, s)
    }
    const reason = reply.reason === 'api-error' ? `the API call failed${reply.status === null ? '' : ` (${reply.status})`}`
      : reply.reason === 'aborted' ? 'the ping was interrupted'
      : 'the ping returned no text'
    // A busy or failing API is usually brief; retry while a ping can still land a minute before the cache goes cold.
    if (reply.reason === 'api-error' && (reply.status === null || reply.status === 429 || reply.status >= 500)) {
      const wait = MIN_PING_MS * 2 ** s.retries
      if (s.retries < MAX_RETRIES && at + wait < Math.min(s.deadline, s.lastRequestAt + TTL_MS - MIN_PING_MS)) {
        s.retries++
        s.retryReason = reason
        // Replaces any timer set while the fork was out, such as a window extension's, so only the retry fires.
        disarm(s)
        s.pending = $.clock.after(wait, () => { void ping($, s) })
        updateStatus($, s, at)
        return
      }
    }
    return stop($, s, reason + afterRetries(s.retries))
  }
  const u = reply.usage
  const price = priceOf(s.lastModel, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
  // A warm ping reads the prefix and writes only its own message; a write of a tenth of the read or more means the prefix broke.
  const warm = u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens
  const usd = price ? pingUsd(u, price) : null
  s.last = { at: now, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, usd, warm }
  if (!warm) return stop($, s, `the ping read ${fmtTok(u.cache_read_input_tokens)} and wrote ${fmtTok(u.cache_creation_input_tokens)} tokens (${fmtUsd(usd)}), the cache was already gone`)
  s.lastRequestAt = now
  await arm($, s)
}

export function afterRetries(n: number): string {
  return n ? ` after ${n} ${n === 1 ? 'retry' : 'retries'}` : ''
}

/** The reply to an arming command; on a cold cache it says when the first ping can come. */
/** How long keepwarm holds the cache after a paid cold write: the rolling window when always is on. */
export function holdMs(s: State): number {
  return s.always ? DEFAULT_WINDOW_MS : AUTO_WARM_MS
}

export function armedText(s: State, now: number, windowMs: number): string {
  if (isCold(s, now)) return `keepwarm on for ${fmtDuration(windowMs)}. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn`
  return `keepwarm on for ${fmtDuration(windowMs)}, a ping ${fmtDuration(s.every)} after each idle stretch keeps the cache read, not re-written`
}

// A /keepwarm off after `offs` was read wins: the window it cancelled is not written back. A caller that awaited
// before deciding to open a window passes the count it read first.
export async function startWindow($: EngineInterface, s: State, windowMs: number, every: number, offs = s.offs) {
  if (s.offs !== offs) return
  const now = await $.clock.now()
  if (s.offs !== offs) return
  const deadline = now + windowMs
  s.every = every
  s.deadline = deadline
  s.stopped = null
  // Unseated, between a conversation's end and the host reporting the next, the window has no id to be written under; the seat writes it.
  if (!s.sid) return arm($, s)
  if (every === PING_AFTER_MS) await $.store.delete(everyKey(s))
  else await $.store.set(everyKey(s), every)
  await $.store.set(deadlineKey(s), deadline)
  if (s.offs !== offs) {
    // Remove only what this call wrote; a window armed after the off is left alone.
    if ((await $.store.get(deadlineKey(s))) === deadline) {
      await $.store.delete(deadlineKey(s))
      if (!s.deadline) await $.store.delete(everyKey(s))
    }
    return
  }
  await arm($, s)
}

export function card(s: State, now: number): string {
  const lines: string[] = []
  lines.push(`${s.lastModel ?? 'model not seen yet'}`)
  if (s.compacted) lines.push('state       reset by compaction, waiting for the first turn')
  else if (s.resumedAt) lines.push(mayBeCold(s, now) ? 'state       unknown, resumed without the time of its last response' : `state       resumed without the time of its last response, warm for up to ${fmtDuration(s.resumedAt + TTL_MS - now)} more`)
  else if (!s.lastRequestAt) lines.push('state       no request yet this session')
  else if (isCold(s, now)) lines.push(`state       COLD, last request ${fmtDuration(now - s.lastRequestAt)} ago`)
  else lines.push(`state       warm, ${fmtDuration(s.lastRequestAt + TTL_MS - now)} left`)
  lines.push(`context     ${s.ctx.toLocaleString('en-US')} tokens`)
  lines.push(`cold cost   ${fmtUsd(coldUsd(s))} to re-write it (warm turn ${fmtUsd(warmUsd(s))})`)
  const always = s.always ? ' (always)' : ''
  const idle = s.always ? 'off until the next turn, which arms 6h00m (always)' : 'off (/keepwarm to arm it for 6h00m)'
  lines.push(`keepwarm    ${s.deadline ? (statusText(s, now) ?? '').replace(/^keepwarm /, 'on, ') + always : s.stopped ? `stopped, ${s.stopped}${always}` : idle}`)
  const verdict = windowVerdict(s, now)
  if (verdict) lines.push(`break-even  ${verdictLine(verdict, verdict.open ? s.every : PING_AFTER_MS)}`)
  lines.push(`guard       ${s.guard === 'refuse' ? 'refuse once (/horizon guard warn to only show the price)' : 'warn only (/horizon guard refuse to be stopped once)'}`)
  lines.push(`handoff     ${handoffLine(s, now)}`)
  const paid = s.misses.reduce((a, m) => a + (m.usd ?? 0), 0)
  lines.push(`session     ${s.misses.length} cold write${s.misses.length === 1 ? '' : 's'} paid, ${fmtUsd(paid)}`)
  return lines.join('\n')
}

/** One line on the handoff note: ready, failed, off, or when it will be written. */
export function handoffLine(s: State, now: number): string {
  if (s.noteWriting) return 'being written…'
  if (s.note) return `ready, written ${fmtDuration(now - s.note.at)} ago for ${fmtUsd(s.note.usd)} (/handoff to /clear and continue from it, /handoff show to read it)`
  const last = s.lastNote ? `; the last one, written ${fmtDuration(now - s.lastNote.at)} ago, is out of date (/handoff show prints it)` : ''
  if (!s.handoffOn) return `off (/horizon handoff on; /handoff now still writes one)${last}`
  if (s.noteFailed) return `not written: ${s.noteFailed}${last}`
  if (s.deadline) return `not needed while keepwarm holds the cache${last}`
  return `written over the warm cache after ${fmtDuration(HANDOFF_FROM_MS)} idle, from ${fmtTok(BIG_TOKENS)} tokens of context${last}`
}

export function freshState(): State {
  return {
    handoffOn: true, note: null, lastNote: null, noteFailed: null, turnNo: 0, noteTriedFor: -1, noteWriting: false, handoffAckedAt: 0,
    hasBand: false, sid: '', deadline: 0, every: PING_AFTER_MS, always: false, lastRequestAt: 0, lastModel: null, ctx: 0, compacted: false,
    resumedAt: 0, transcript: 0, guard: 'refuse', ackedAt: 0, coldWritePending: false, misses: [], pending: null, last: null, stopped: null,
    waitForTurn: false, retries: 0, retryReason: '', gen: 0, tick: 0, offs: 0, turnOffs: null, inFlight: false, stepWrites: null, coldWrites: null, steps: 0, endingSid: '',
  }
}

/**
 * Writes the handoff note once per idle stretch, while the cache is still warm: a fork reads the
 * cached prefix at the read rate, so the note costs cents where a cold comeback costs dollars.
 * Called from the band's ticker. Not while keepwarm holds the cache (nothing will go cold), not
 * under the guard's floor, never twice for the same turn. A warm fork also refreshes the cache,
 * so its read moves the cache clock, as a keepwarm ping does.
 */
export async function maybePrepareHandoff($: EngineInterface, s: State): Promise<void> {
  if (!s.handoffOn || s.deadline || s.inFlight || s.compacted || !s.lastRequestAt || s.ctx < BIG_TOKENS) return
  if (s.noteTriedFor === s.turnNo || (s.note && s.note.forTurn === s.turnNo)) return
  const now = await $.clock.now()
  const idle = now - s.lastRequestAt
  if (idle < HANDOFF_FROM_MS || idle >= HANDOFF_UNTIL_MS) return
  // Checked again after the await, then claimed with no await in between (writeHandoff sets inFlight before its first await).
  if (s.inFlight || s.deadline || s.noteTriedFor === s.turnNo) return
  s.noteTriedFor = s.turnNo
  await writeHandoff($, s)
}

/**
 * One fork for a handoff note over the conversation as it stands. Sets inFlight before its first
 * await, so a caller that checked it with no await since holds the claim. A fork over a cold cache
 * re-writes the prefix: that is scored as a cold write paid, and the cache is warm again after it.
 */
export async function writeHandoff($: EngineInterface, s: State): Promise<'written' | 'failed' | 'outdated'> {
  s.inFlight = true
  s.noteWriting = true
  const gen = s.gen
  const sentAt = s.lastRequestAt
  const turn = s.turnNo
  const ctx = s.ctx
  $.ui.invalidate('ui.render')
  const sent = await $.model.fork({ prompt: HANDOFF_PROMPT }).then(reply => ({ reply }), (err: unknown) => ({ err }))
  const at = await $.clock.now()
  s.inFlight = false
  s.noteWriting = false
  // A /clear, compaction or a new message replaced what the note was written for.
  if (gen !== s.gen || s.lastRequestAt !== sentAt || turn !== s.turnNo) {
    if (s.deadline && !s.pending) await arm($, s)
    $.ui.invalidate('ui.render')
    return 'outdated'
  }
  let result: 'written' | 'failed' = 'failed'
  if ('err' in sent) {
    s.noteFailed = sent.err instanceof Error ? sent.err.message : String(sent.err)
  } else if (!sent.reply.isAnswered) {
    s.noteFailed = sent.reply.reason === 'nothing-to-fork' ? 'nothing to fork yet' : `the fork ended with ${sent.reply.reason}`
  } else {
    const u = sent.reply.usage
    const price = priceOf(s.lastModel, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
    s.note = { text: sent.reply.text.trim(), at, usd: price ? pingUsd(u, price) : null, forTurn: turn }
    s.lastNote = s.note
    s.noteFailed = null
    result = 'written'
    // A warm read refreshed the cache; a full re-write over a cold one paid for it and left it warm too.
    const warm = u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens
    const rewrote = ctx > 0 && u.cache_creation_input_tokens >= 0.5 * ctx
    if (rewrote) s.misses.push({ at, tokens: u.cache_creation_input_tokens, usd: price ? u.cache_creation_input_tokens * price[1] / 1e6 : null })
    if (warm || rewrote) s.lastRequestAt = at
  }
  if (s.deadline && !s.pending) await arm($, s)
  updateStatus($, s, at)
  return result
}

/** How long a cold /handoff now waits for the second one that pays the re-write. */
export const HANDOFF_ACK_MS = 2 * 60 * 1000
/** About what the note's answer runs to, for the estimate before it is written. */
const NOTE_OUTPUT_TOKENS = 500

/** What a note would cost now: the read of the warm prefix and the answer, or the re-write of a cold one. */
export function noteCostEstimate(s: State, now: number): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  if (!price || s.ctx <= 0) return null
  const prefix = isCold(s, now) ? s.ctx * price[1] : s.ctx * price[0]
  return (prefix + NOTE_OUTPUT_TOKENS * price[2]) / 1e6
}

/**
 * /handoff now: a note written at once, whatever the idle time, keepwarm or the handoff switch.
 * On a cold cache the first call shows the re-write's price and a second within two minutes pays
 * it, as the guard does. The fork runs in the background (a command hook that waited on it would
 * hold the prompt); a toast says how it went. Returns the command's answer.
 */
export async function handoffNow($: EngineInterface, s: State): Promise<string> {
  const now = await $.clock.now()
  if (!s.lastRequestAt || s.compacted) return 'Nothing to write a note from yet: the conversation needs a reply first (after a compaction, the next turn).'
  if (s.inFlight) return s.noteWriting ? 'A handoff note is being written already; a toast says when it is ready.' : 'A keepwarm ping is out right now; try /handoff now again in a moment.'
  if (s.note && s.note.forTurn === s.turnNo) return 'A note for this point of the conversation is ready already: /handoff to clear and continue from it, /handoff show to read it.'
  const usd = noteCostEstimate(s, now)
  if (isCold(s, now)) {
    if (!s.handoffAckedAt || now - s.handoffAckedAt >= HANDOFF_ACK_MS) {
      s.handoffAckedAt = now
      return `The prompt cache went cold ${fmtDuration(now - s.lastRequestAt - TTL_MS)} ago, so the note first re-writes up to ${s.ctx.toLocaleString('en-US')} tokens: about ${fmtUsd(usd)}. ` +
        `Run /handoff now again within ${fmtDuration(HANDOFF_ACK_MS)} to pay it, or /clear and describe the task in a sentence or two.`
    }
  }
  s.handoffAckedAt = 0
  s.noteTriedFor = s.turnNo
  // No await between the inFlight check above and writeHandoff's claim.
  void writeHandoff($, s).then(result => {
    if (result === 'written') $.ui.toast(`horizon: handoff note ready (${fmtUsd(s.note?.usd ?? null)}). /handoff to clear and continue, /handoff show to read it.`)
    else if (result === 'failed') $.ui.toast(`horizon: the handoff note was not written: ${s.noteFailed ?? 'unknown error'}`)
    else $.ui.toast('horizon: the conversation moved on while the note was written, so it was dropped. /handoff now to write a fresh one.')
  })
  return `Writing a handoff note (about ${fmtUsd(usd)}); a toast says when it is ready.`
}

/** What one ping costs: the last warm ping's bill, or a read of the context with a one-word answer. */
export function pingCostEstimate(s: State): number | null {
  if (s.last?.warm && s.last.usd != null) return s.last.usd
  const price = priceOf(s.lastModel, s.ctx)
  if (!price || s.ctx <= 0) return null
  return pingUsd({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: s.ctx, cache_creation_input_tokens: 20 }, price)
}

/** The pings a keepwarm window has left to send against one cold re-write of the context. */
export type Verdict = { per: number; pings: number; pingsUsd: number; coldUsd: number; breakEven: number; worth: boolean; open: boolean }

/**
 * Whether keepwarm pays: the pings left in the open window, or in a fresh default window when none
 * is open, cost less than one cold re-write. Pings go out every `every` after the last request,
 * up to the deadline.
 */
export function windowVerdict(s: State, now: number): Verdict | null {
  const per = pingCostEstimate(s)
  const cold = coldUsd(s)
  if (per == null || cold == null || per <= 0 || s.ctx <= 0) return null
  const open = s.deadline > now
  const deadline = open ? s.deadline : now + DEFAULT_WINDOW_MS
  const every = open ? s.every : PING_AFTER_MS
  const from = s.lastRequestAt > 0 ? s.lastRequestAt : now
  const first = Math.max(now, from + every)
  const pings = first < deadline ? 1 + Math.floor((deadline - first) / every) : 0
  return { per, pings, pingsUsd: pings * per, coldUsd: cold, breakEven: Math.floor(cold / per), worth: pings * per < cold, open }
}

/** One line on the verdict, for the card and /horizon. */
export function verdictLine(v: Verdict, every: number): string {
  const window = v.open ? `${v.pings} left in this window` : `a ${fmtDuration(DEFAULT_WINDOW_MS)} window: ${v.pings} pings`
  return `each ping ≈ ${fmtUsd(v.per)} · one cold write ${fmtUsd(v.coldUsd)} = ${v.breakEven} pings (≈${fmtDuration(v.breakEven * every)} idle) · ` +
    `${window}, ${fmtUsd(v.pingsUsd)} ${v.worth ? '✓ worth it' : '≥ a cold write, not worth it'}`
}

export const KEY_HANDOFF = 'handoff'

