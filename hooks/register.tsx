import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Fold } from '../types'
import {
  AUTO_WARM_MS, BIG_TOKENS, DEFAULT_WINDOW_MS, HANDOFF_FROM_MS, KEY_ALWAYS, KEY_GUARD, KEY_HANDOFF, MIN_PING_MS, PING_AFTER_MS, TTL_MS, UNATTENDED, arm, armedText, card, coldUsd, deadlineKey, disarm, endConversation, everyKey, fmtDuration, fmtTok, fmtUsd, freshState, guardText, handoffLine, handoffNow, holdMs, isCold, markCompacted, mayBeCold, maybePrepareHandoff, outdate, parseDuration, ping, priceOf, prune, reseat, seat, seedFromResume, startWindow, statusText, stop, unknownText, updateStatus, verdictLine, warmUsd, windowVerdict,
} from './keepwarm'
import type { State } from './keepwarm'
import { cellsOf, forecastFor, gaugeOf, lastReading, measureTurn, pushReading, refreshAgents, resetWeather, seedWeather, short, sortLimits, sparkline, trend, w } from './weather'
import type { Cell, Gauge } from './weather'

// One band above the prompt, in the spirit of Ribbon (robonuggets/ribbon, MIT): a warm dark
// strip, cream text, dot bars for what is LEFT of each window, a WARM / COLD chip for the
// prompt cache, and a card to open for the details. The figures are Token Weather Usage's
// (augiefra/claude-mods, Apache-2.0); the guard, keepwarm and cold-write scoring are Cache
// Tax's (karanb192/cache-tax, MIT), see keepwarm.ts.

// Ribbon's palette.
const BG = '#24221c'
const TEXT = '#e8e2d2'
const MUTED = '#8d8775'
const EMPTY = '#4a463b'
const INK = '#1c1a16'
const YELLOW = '#f5a623'
const GREEN = '#8fbf6a'
const RED = '#e06c5a'
const HUE = { warm: '#cc6363', cold: '#6aaabd', soon: YELLOW, none: MUTED } as const
const NAMES: Record<string, string> = { five_hour: '5H', seven_day: '7D', spend_limit: 'SPEND' }
// Token Weather Usage's pace colors, toned for the dark band: green behind the clock, amber ahead of it,
// red well ahead (15 points) or past 90% used.
const TONE: Record<string, string> = { calm: '#6fbf73', fast: '#e0a03a', alert: RED }
const GLYPH = { used: '━', ahead: '╍', margin: '╍', empty: '─' } as const

const CELLS = 10
const TIGHT_CELLS = 6
const SOON_MS = 10 * 60 * 1000
const TICK_MS = 30_000
// The desktop's smaller text step keeps the band compact; the terminal has one size, its font's.
const SIZE = 'footnote' as const

const fold = atom({ plugin: 'horizon', key: 'fold' } as const, null as Fold | null)

type CacheMode = 'warm' | 'soon' | 'cold' | 'none'
type CacheView = { mode: CacheMode; idleMs: number; leftMs: number; tokens: number; warm: number | null; cold: number | null }

export function cacheViewOf(s: State, now: number): CacheView {
  const tokens = s.ctx
  const warm = warmUsd(s)
  const cold = coldUsd(s)
  if (!s.lastRequestAt || s.compacted || tokens <= 0) return { mode: 'none', idleMs: 0, leftMs: 0, tokens, warm, cold }
  const idleMs = Math.max(0, now - s.lastRequestAt)
  const leftMs = s.lastRequestAt + TTL_MS - now
  const mode: CacheMode = isCold(s, now) ? 'cold' : leftMs < SOON_MS ? 'soon' : 'warm'
  return { mode, idleMs, leftMs, tokens, warm, cold }
}

// Models priced on the card, the person's own marked YOU.
const CARD_MODELS: Array<[string, string]> = [
  ['OPUS', 'claude-opus-5-5'], ['SONNET', 'claude-sonnet-5-5'], ['HAIKU', 'claude-haiku-5-5'],
]
const familyOf = (model: string | null) => {
  const m = (model ?? '').toLowerCase()
  return CARD_MODELS.find(([name]) => m.includes(name.toLowerCase()))?.[0] ?? null
}

/** The agents' names for the hover, cut to fit beside the band's other segments: `a, b +2`. */
const NAMES_MAX = 40
function agentNames(names: readonly string[], lead: string): string {
  if (!names.length) return ''
  let shown = lead
  let i = 0
  for (; i < names.length; i++) {
    const next = (i ? ', ' : '') + names[i]
    if (i > 0 && shown.length + next.length > NAMES_MAX) break
    shown += next
  }
  if (shown.length > NAMES_MAX) shown = shown.slice(0, NAMES_MAX - 1) + '…'
  return i < names.length ? `${shown} +${names.length - i}` : shown
}

/** /clear, then the handoff note in the prompt box to edit and send. */
async function clearAndFill($: EngineInterface, text: string) {
  try {
    await $.command.run({ command: 'clear' })
    await $.prompt.fill({ text })
  } catch (err) {
    $.ui.log(`horizon: could not clear and fill the note (${err instanceof Error ? err.message : String(err)}); /handoff show prints it`)
  }
}

/** Every 30 s: the handoff's moment, the agents running, and a redraw for the countdowns. */
async function tick($: EngineInterface, s: State) {
  await maybePrepareHandoff($, s)
  await refreshAgents($)
  $.ui.invalidate('ui.render')
}

export const register: Register = on => {
  const s = freshState()
  let ticker: { cancel: () => void } | null = null

  // ---- The cache engine (Cache Tax): guard, keepwarm, cold-write scoring, handoff. ----

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // The horizon band draws this state on every surface that has a band.
    s.hasBand = true
    s.handoffOn = (await $.store.get(KEY_HANDOFF)) !== false
    const now = await seat($, s)
    await prune($, s, now)
    const saved = await $.store.get(deadlineKey(s))
    const savedEvery = await $.store.get(everyKey(s))
    const savedGuard = await $.store.get(KEY_GUARD)
    s.deadline = typeof saved === 'number' && saved > now ? saved : 0
    s.every = typeof savedEvery === 'number' && savedEvery >= MIN_PING_MS && savedEvery < TTL_MS ? savedEvery : PING_AFTER_MS
    s.guard = savedGuard === 'warn' ? 'warn' : 'refuse'
    s.always = (await $.store.get(KEY_ALWAYS)) === true
    // Always means a fresh default window every session, whatever the last one left behind.
    if (s.always) await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
    // The classic start arms a restored window too, but a managed plugin above this tier may continue beneath it; arming twice leaves one timer.
    else if (s.deadline) await arm($, s)
    // Cache Tax itself (mod or hook form) installed beside this one means two guards on every cold send.
    const commands = await $.command.list()
    if (commands.some(c => c.name === 'cache-tax' || c.name === 'cache-tax:status')) {
      $.ui.log('horizon: Cache Tax is also installed, so a cold send is guarded twice and keepwarm may ping twice. Uninstall one of them.')
    }
    await $.command.register({
      name: 'keepwarm',
      description: 'Keep the prompt cache warm: bare for 6h, a window such as 90m, always, off, or status (horizon)',
      argumentHint: '[6h | always | off | status]',
      immediate: true,
    })
    await $.command.register({
      name: 'horizon',
      description: 'Prompt cache card: state, cold price, keepwarm, handoff; guard warn|refuse, handoff on|off (horizon)',
      argumentHint: '[guard warn | guard refuse | handoff on | handoff off]',
      immediate: true,
    })
    await $.command.register({
      name: 'handoff',
      description: 'Clear and continue from the handoff note written before the cache went cold; now to write one at once, show to read it (horizon)',
      argumentHint: '[now | show]',
    })
    updateStatus($, s, now)
    // The band's figures and its ticker: the countdown, agents, and the handoff's moment.
    ticker?.cancel()
    resetWeather()
    await seedWeather($)
    ticker = $.clock.every(TICK_MS, () => { void tick($, s) })
    $.ui.invalidate('ui.render')
    return r
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    await reseat($, s)
    const arg = String(e.args ?? '').trim()
    if (arg === 'now') return { text: await handoffNow($, s) }
    const note = s.note
    const now = await $.clock.now()
    // An out-of-date note can still be read, marked as such; only a current one is continued from.
    if (arg === 'show' && !note && s.lastNote) {
      return { text: `(Out of date: written ${fmtDuration(now - s.lastNote.at)} ago, before the conversation moved on. /handoff now writes a fresh one.)\n\n${s.lastNote.text}` }
    }
    if (!note) {
      return { text: `No handoff note is ready (${handoffLine(s, now)}). /handoff now writes one; without one: /compact, or /clear and describe the task in a sentence or two.` }
    }
    if (arg === 'show') return { text: note.text }
    // A command hook cannot run /clear itself (it would wait on this hook): the clock runs it just after.
    $.clock.after(50, () => { void clearAndFill($, note.text) })
    return { text: 'Clearing the conversation; the handoff note will be in your prompt box to edit and send.' }
  })

  // On Team and Enterprise accounts a managed plugin seated above this tier handles classic.* and continues beneath it, so
  // nothing here is relied on alone: session.end carries the /clear, turn.step the compaction, and the engine's own figures
  // the resumed context. What arrives here refines that, once: a clear already ended is only seated, a seat is never redone.
  on('session.end', async ($, e, next) => {
    // Only the conversation this state sits in: after the classic start of the next one, the old id is history.
    if ((e.reason === 'clear' || e.reason === 'resume') && e.sessionId === s.sid) await endConversation($, s, e.reason)
    // A real end; /clear and /resume keep the ticker.
    if (e.reason === 'prompt_input_exit' || e.reason === 'other' || e.reason === 'logout') ticker?.cancel()
    return next(e)
  })

  // Resume fields seed the guard before any turn of the resumed session has run.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    // A resumed or cleared conversation is not the one a ping in flight was sent for.
    outdate(s)
    // The conversation moved under this state without session.end reaching it: the payload names another id, or a
    // clear names none. One that already seated the new id (a command ran first) is left as it is.
    if (s.sid && (e.session_id === undefined ? e.source === 'clear' : e.session_id !== s.sid)) await endConversation($, s, e.source === 'clear' ? 'clear' : 'resume')
    // No session.start fires after /clear, so this is where always arms the new conversation.
    await reseat($, s)
    if (e.source === 'clear') {
      resetWeather()
      await update($, fold, () => null)
      $.ui.invalidate('ui.render')
      return r
    }
    const line = seedFromResume(s, e, await $.clock.now())
    if (line) $.ui.log(line)
    // The seeded clock decides whether a restored or always window pings before the first turn: never when it is cold.
    await arm($, s)
    return r
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    await reseat($, s)
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    if (words[0] === 'off') {
      const wasAlways = s.always
      await stop($, s, null, true)
      return { text: wasAlways ? 'keepwarm is off, and always is off for every session from its next turn' : 'keepwarm is off' }
    }
    if (words[0] === 'always') {
      s.always = true
      await $.store.set(KEY_ALWAYS, true)
      await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
      const cold = isCold(s, now) ? `. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn` : ''
      return { text: `keepwarm always on: every session stays warm until ${fmtDuration(DEFAULT_WINDOW_MS)} after its last turn; /keepwarm off turns it off for good${cold}` }
    }
    if (!words.length) {
      await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
      return { text: armedText(s, now, DEFAULT_WINDOW_MS) }
    }
    if (words[0] !== 'status') {
      const window = parseDuration(words[0] ?? '')
      if (!window) return { text: 'keepwarm takes a window such as 6h or 90m, or always, off, or status' }
      // "every 2m" is a testing knob and lasts only for the window it was given with.
      let every = PING_AFTER_MS
      if (words[1] === 'every') {
        const period = parseDuration(words[2] ?? '')
        // A period of the cache's whole hour or more would fire only once the cache is already cold.
        if (period == null || period < MIN_PING_MS || period >= TTL_MS) return { text: 'every takes a period from 1m to 59m' }
        every = period
      }
      await startWindow($, s, window, every)
      const rolls = s.always && (window < DEFAULT_WINDOW_MS || every !== PING_AFTER_MS)
      return { text: armedText(s, now, window) + (rolls ? `. Always is on, so your next turn makes it at least ${fmtDuration(DEFAULT_WINDOW_MS)} at one ping per ${fmtDuration(PING_AFTER_MS)}` : '') }
    }
    return { text: statusText(s, now) ?? 'keepwarm is off' }
  })

  on('command.run', { command: 'horizon' }, async ($, e) => {
    await reseat($, s)
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    if (words[0] === 'handoff') {
      if (words[1] !== 'on' && words[1] !== 'off') return { text: '/horizon handoff takes on or off' }
      s.handoffOn = words[1] === 'on'
      await $.store.set(KEY_HANDOFF, s.handoffOn)
      updateStatus($, s, now)
      return { text: s.handoffOn ? `handoff on: a note is written over the warm cache after ${fmtDuration(HANDOFF_FROM_MS)} idle, for a few cents` : 'handoff off: no note is written before the cache goes cold' }
    }
    if (words[0] === 'guard') {
      if (words[1] !== 'warn' && words[1] !== 'refuse') return { text: '/horizon guard takes warn or refuse' }
      s.guard = words[1]
      await $.store.set(KEY_GUARD, s.guard)
      return { text: s.guard === 'refuse' ? 'guard set to refuse once: a cold send is dropped with its price, the resend goes through' : 'guard set to warn: a cold send goes through with its price shown' }
    }
    return { text: card(s, now) }
  })

  // The message that pays. Only its first character is read.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin') return next(e)
    await reseat($, s)
    if (typeof e.text !== 'string' || e.text.trimStart().startsWith('/')) return next(e)
    const now = await $.clock.now()
    // Without the time of the last response nothing says whether the cache is cold: the price is shown once and the message goes through.
    if (s.resumedAt) {
      const cold = mayBeCold(s, now)
      s.resumedAt = 0
      if (cold && s.ctx >= BIG_TOKENS) $.ui.log(unknownText(s))
      return next(e)
    }
    if (!isCold(s, now) || s.ctx < BIG_TOKENS) return next(e)
    // A refused prompt that no person sent would be lost: nobody is there to send it again.
    const unattended = UNATTENDED.has(e.origin.kind)
    if (s.guard === 'warn' || unattended) {
      $.ui.log(`${guardText(s, now)} Sending anyway${unattended ? `, since this ${e.origin.kind} prompt cannot be sent again` : ''}; keepwarm will hold the cache for ${fmtDuration(holdMs(s))} once it lands.`)
      s.coldWritePending = true
      return next(e)
    }
    if (s.ackedAt === s.lastRequestAt) {
      s.ackedAt = 0
      s.coldWritePending = true
      return next(e)
    }
    s.ackedAt = s.lastRequestAt
    const way = s.note ? 'Or /handoff: clear and continue from the note written before it went cold.' : 'Or /clear and start from a note (/compact also re-reads it all).'
    $.ui.invalidate('ui.render')
    return { drop: `horizon: ${guardText(s, now)} Send it again to pay it, and keepwarm will then hold the cache for ${fmtDuration(holdMs(s))}. ${way}` }
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      await reseat($, s)
      // The off count when the turn's first request went out: an off after it wins over what the turn opens.
      if (e.index === 0) s.turnOffs = s.offs
      // A compaction leaves a summary where tens of messages were; a rewind takes a few off. A request over fewer than half the
      // last one's messages is read as a compaction, whether or not session.compact arrived. The context stays as it was, so
      // turn.complete still scores a cold write this turn paid against it before the live figure replaces it.
      if (e.messageCount * 2 < s.transcript) markCompacted(s)
      s.transcript = e.messageCount
      // Only a request sent before any compaction this turn saw can hold a cold write; what follows one is the summary.
      if (!s.compacted) s.steps++
      s.lastRequestAt = await $.clock.now()
    }
    const r = yield* next(e)
    // Each request's write is priced at its own prompt length's tier (Haiku 5.5 changes price at 100k), not the turn's sum.
    const u = r.usage
    if (!e.agentId && u && !s.compacted) {
      const price = priceOf(u.model || e.model, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
      const was = s.stepWrites ?? { tokens: 0, usd: 0, priced: true }
      s.stepWrites = { tokens: was.tokens + u.cache_creation_input_tokens, usd: was.usd + (price ? u.cache_creation_input_tokens * price[1] / 1e6 : 0), priced: was.priced && price != null }
    }
    // A main request may have started an agent.
    if (!e.agentId && u) {
      await refreshAgents($)
      $.ui.invalidate('ui.render')
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) {
      await refreshAgents($)
      $.ui.invalidate('ui.render')
      return r
    }
    // An off at any point in this turn wins over every window the turn would open; a host that raised no
    // step falls back to the count at completion.
    const offs = s.turnOffs ?? s.offs
    s.turnOffs = null
    const now = await $.clock.now()
    // A sleeping host may deliver this turn before the expired window's timer.
    if (s.deadline && now >= s.deadline) await stop($, s, null)
    // turn.step stamps the exact request time; when no step of this turn did, the turn's end is the floor.
    // A turn aborted before it sent anything touched no cache, so it leaves the clock alone.
    if ((e.usage || !e.isAborted) && now - s.lastRequestAt > e.durationMs) s.lastRequestAt = now
    const compacted = s.compacted
    s.compacted = false
    if (s.lastRequestAt) s.resumedAt = 0
    s.waitForTurn = false
    s.ackedAt = 0
    // Always covers any break up to six hours after a turn that reached the cache (a turn that failed before any
    // response touched nothing, and its cache may be cold): a window of at least six hours at the default period,
    // which brings back a stopped window and replaces a shorter one or a testing period. Another session's
    // /keepwarm off or /keepwarm always changes the shared switch, so every such turn reads it.
    if (e.usage) {
      const shared = (await $.store.get(KEY_ALWAYS)) === true
      if (s.offs === offs) s.always = shared
      if (s.always) await startWindow($, s, Math.max(DEFAULT_WINDOW_MS, s.deadline - now), PING_AFTER_MS, offs)
    }
    const u = e.usage
    if (u) {
      if (u.model) s.lastModel = u.model
      const prev = s.ctx
      // A turn's usage is its responses summed, so a ten-step turn reports ten
      // reads of the context. The live window is the engine's figure; the sum
      // is only the fallback for a host that reports no tokens.
      const written = u.cache_creation_input_tokens
      const live = (await $.session.usage()).context.tokens
      s.ctx = live && live > 0 ? live : u.input_tokens + u.cache_read_input_tokens + written
      // A compaction since the last complete turn: what followed it is the summary, no cold write, so the turn is scored
      // on the requests before it alone. None before it leaves nothing to score, whatever the guard saw; requests before
      // it that reported no usage leave only the turn's total, an upper bound kept for a send the guard saw go cold.
      const writes = s.stepWrites
      const write = !compacted ? written : writes ? writes.tokens : s.steps && s.coldWritePending ? written : 0
      const full = prev > 20000 && write >= 0.5 * prev
      if (full || (s.coldWritePending && write > 0)) {
        // Priced per request when the steps reported usage; otherwise at the tier of the context the comeback re-sent.
        const price = priceOf(s.lastModel, prev || s.ctx)
        const usd = writes?.priced ? writes.usd : price ? write * price[1] / 1e6 : null
        s.misses.push({ at: now, tokens: write, usd })
        const extend = s.deadline < now + AUTO_WARM_MS && s.offs === offs
        if (extend) await startWindow($, s, AUTO_WARM_MS, s.every, offs)
        $.ui.log(`cold write of ${fmtTok(write)} tokens paid (${fmtUsd(usd)}).` +
          (extend ? ` Keeping the cache warm for ${fmtDuration(AUTO_WARM_MS)} so it is not paid again today; /keepwarm off to stop.` : ''))
      }
    }
    s.coldWritePending = false
    s.stepWrites = null
    s.steps = 0
    // A new main turn: the note written for the last one is out of date.
    if (e.usage) {
      s.turnNo++
      if (s.note && s.note.forTurn !== s.turnNo) s.note = null
      s.noteFailed = null
    }
    await arm($, s)
    try {
      await measureTurn($)
    } catch {
      // No reading this turn: the band keeps the previous one.
    }
    $.ui.invalidate('ui.render')
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      markCompacted(s)
      // Between turns nothing is left to score, and the next turn's summary write is not a cold write.
      s.ctx = 0
      disarm(s)
      await arm($, s)
      if (e.trigger !== 'precompute' && r && typeof r.skip !== 'string') {
        const last = lastReading()
        if (typeof r.tokensAfter === 'number' && r.tokensAfter > 0 && last) pushReading({ tokens: r.tokensAfter, window: last.window })
        else pushReading((await $.session.usage()).context)
        $.ui.invalidate('ui.render')
      }
    }
    return r
  })

  // ---- The band. ----

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits') && e.rateLimits.length > 0) w.limits = sortLimits(e.rateLimits)
    if (e.cost) w.cost = e.cost.usd
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const below = await next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const now = await $.clock.now()
    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 100
    const cells = columns < 60 ? TIGHT_CELLS : CELLS
    const reading = lastReading()
    const view = cacheViewOf(s, now)
    const verdict = windowVerdict(s, now)

    if (!reading && w.limits.length === 0 && view.mode === 'none') {
      return (
        <Box flexDirection="column">
          <Box backgroundColor={BG} paddingX={1}><Text size={SIZE} color={MUTED}>horizon · waiting for the first reply</Text></Box>
          {below}
        </Box>
      )
    }

    const seg = (key: string, children: RenderChildren) => (
      <Box key={key} flexDirection="row" flexShrink={0} marginRight={2}>{children}</Box>
    )
    const segs = []

    // Context and its weather, a bar per recent prompt, the last prompt's change.
    if (reading && reading.tokens > 0) {
      const f = forecastFor(reading.percent)
      const sp = sparkline()
      const t = trend()
      segs.push(seg('ctx', [
        <Text size={SIZE} key="i" color={f.color} bold>{f.icon} </Text>,
        <Text size={SIZE} key="n" color={TEXT} bold>{short(reading.tokens)}</Text>,
        <Text size={SIZE} key="p" color={MUTED}> {reading.percent}%</Text>,
        sp.now ? <Text size={SIZE} key="sp" color={EMPTY}> {sp.past}</Text> : null,
        sp.now ? <Text size={SIZE} key="sn" color={f.color}>{sp.now}</Text> : null,
        t ? <Text size={SIZE} key="t" color={MUTED}> {t}</Text> : null,
      ]))
    }

    // Each window as Token Weather Usage draws it: the share used against the time elapsed, colored by
    // pace, then the reset and where the pace so far ends up (or when it runs out, before the reset).
    const gauge = (g: Gauge) => {
      const tone = TONE[g.tone] ?? TEXT
      // Neighbouring cells of one kind are one Text.
      const runs: Array<{ kind: Cell; n: number }> = []
      for (const c of cellsOf(g, cells)) {
        const last = runs[runs.length - 1]
        if (last && last.kind === c) last.n++
        else runs.push({ kind: c, n: 1 })
      }
      const proj = g.projected
      return seg(`w-${g.kind}`, [
        <Text size={SIZE} key="n" color={MUTED} bold>{NAMES[g.kind] ?? g.kind.toUpperCase()} </Text>,
        ...runs.map((run, i) => (
          <Text size={SIZE} mono key={`b${i}`} color={run.kind === 'used' || run.kind === 'ahead' ? tone : run.kind === 'margin' ? MUTED : EMPTY}>
            {GLYPH[run.kind].repeat(run.n)}
          </Text>
        )),
        <Text size={SIZE} key="u" color={tone} bold> {Math.round(g.used)}%</Text>,
        g.reset ? <Text size={SIZE} key="r" color={MUTED}> · {g.reset}</Text> : null,
        g.out
          ? <Text size={SIZE} key="out" color={g.outSoon ? RED : TONE.fast} bold> ⚠ out {g.out}</Text>
          : proj !== null
            ? <Text size={SIZE} key="proj" color={proj >= 85 ? TONE.fast : MUTED}> → {proj}% at reset</Text>
            : null,
      ])
    }
    for (const l of w.limits) segs.push(gauge(gaugeOf(l, now)))

    // The prompt cache: the chip, the time left or idle, what the next message costs.
    const hue = HUE[view.mode]
    const word = view.mode === 'cold' ? 'COLD' : view.mode === 'none' ? 'CACHE' : 'WARM'
    const cacheBits = [<Text size={SIZE} key="chip" backgroundColor={hue} color={INK} bold>{` ${word} `}</Text>]
    if (view.mode === 'warm' || view.mode === 'soon') {
      cacheBits.push(<Text size={SIZE} key="left" color={hue} bold> {fmtDuration(view.leftMs)} left</Text>)
      if (view.mode === 'soon' && view.cold != null && view.tokens >= BIG_TOKENS && !s.deadline) {
        // Keepwarm is off and the cache is about to lapse: a dim ♨, green when a default window would cost less than the re-write.
        cacheBits.push(<Text size={SIZE} key="kw-hint" color={verdict?.worth ? GREEN : MUTED} dimColor> ♨</Text>)
        cacheBits.push(<Text size={SIZE} key="stake" color={MUTED}> · {fmtUsd(view.cold)} at stake</Text>)
      } else if (view.warm != null) cacheBits.push(<Text size={SIZE} key="next" color={MUTED}> · next {fmtUsd(view.warm)}</Text>)
    } else if (view.mode === 'cold') {
      cacheBits.push(<Text size={SIZE} key="idle" color={hue} bold> {fmtDuration(view.idleMs)} idle</Text>)
      cacheBits.push(<Text size={SIZE} key="next" color={TEXT} bold> · next {view.cold == null ? `${short(view.tokens)} to rewrite` : fmtUsd(view.cold)}</Text>)
    } else {
      cacheBits.push(<Text size={SIZE} key="wait" color={MUTED}>{s.compacted ? ' compacted' : ' —'}</Text>)
    }
    // ♨ green while the pings left cost less than one cold write; amber with ≥ once they cost as much or more.
    if (s.deadline && now < s.deadline) {
      const worth = !verdict || verdict.worth
      cacheBits.push(<Text size={SIZE} key="kw" color={worth ? GREEN : TONE.fast} bold> ♨{worth ? '' : '≥'} {fmtDuration(s.deadline - now)}</Text>)
    }
    else if (s.stopped) cacheBits.push(<Text size={SIZE} key="kw" color={MUTED}> ♨ stopped</Text>)
    // ✎ for the rest of the session once a note was written: green "note" while it is current, dim once the conversation moved past it.
    if (s.note) cacheBits.push(<Text size={SIZE} key="note" color={GREEN}> ✎ note</Text>)
    else if (s.noteWriting) cacheBits.push(<Text size={SIZE} key="note" color={MUTED}> ✎…</Text>)
    else if (s.lastNote) cacheBits.push(<Text size={SIZE} key="note" color={MUTED} dimColor> ✎</Text>)
    segs.push(seg('cache', cacheBits))

    // The session's cost, and what the last prompt added in dollars and in 5-hour points.
    if (w.cost != null && w.cost > 0) {
      const extra = [w.lastPrompt != null && w.lastPrompt >= 0.01 ? `+${fmtUsd(w.lastPrompt)}` : '', w.lastPrompt5h ? `+${w.lastPrompt5h}pt 5h` : ''].filter(Boolean).join(' · ')
      segs.push(seg('cost', [
        <Text size={SIZE} key="c" color={TEXT} bold>≈{fmtUsd(w.cost)}</Text>,
        extra ? <Text size={SIZE} key="x" color={MUTED}> ({extra})</Text> : null,
      ]))
    }

    if (w.agents.total > 0) {
      const running = w.agents.running > 0
      const names = agentNames(running ? w.agents.names : w.agents.recent, running ? '' : 'ran: ')
      segs.push(seg('agents', [
        ...(running
          ? [<Text size={SIZE} key="r" color={HUE.warm} bold>⚙ {w.agents.running} running</Text>, <Text size={SIZE} key="t" color={MUTED}> · {w.agents.total}</Text>]
          : [<Text size={SIZE} key="t" color={MUTED}>⚙ {w.agents.total} agent{w.agents.total === 1 ? '' : 's'}</Text>]),
        // The names, only while the pointer is on the segment: laid over it on the band's own row (above the band would be
        // clipped), so nothing moves and the folded band keeps its one row.
        names
          ? <Box position="absolute" top={0} left={0} display="none" hover={{ display: 'flex' }} flexDirection="row" flexShrink={0} backgroundColor={BG}>
              <Text size={SIZE} key="agent-names" color={running ? HUE.warm : MUTED} bold>⚙ {names}</Text>
            </Box>
          : null,
      ]))
    }

    // The card: open by default when cold, folded otherwise; a choice holds until the state flips.
    const foldMode: Fold['mode'] = view.mode === 'cold' ? 'cold' : view.mode === 'none' ? 'none' : 'warm'
    const stored = await read($, fold)
    // The same card and buttons on every surface: the terminal presses them by click, Enter or hotkey (ctrl+x tab focuses the band).
    const open = stored && stored.mode === foldMode ? stored.open : foldMode === 'cold'
    const toggle = () => update($, fold, f => ({ mode: foldMode, open: !(f && f.mode === foldMode ? f.open : foldMode === 'cold') }))

    const row = (
      <Box key="row" flexDirection="row" paddingX={1} alignItems="center">
        <Box flexDirection="row" flexWrap="wrap" flexGrow={1} flexShrink={1}>{segs}</Box>
        <Box flexShrink={0}><Button key="horizon-fold" label={open ? 'Hide' : 'Show'} hotkey="w" onPress={toggle} /></Box>
      </Box>
    )

    let card = null
    if (open) {
      const mine = familyOf(s.lastModel)
      // The row above already says warm or cold, the time left and the price; the card adds the size and the
      // other models. Without a cache yet, it says why.
      const pending = view.mode === 'none' ? (s.compacted ? 'the cache is rebuilt by the next message after the compaction' : 'no request yet') : null
      const prices = view.tokens > 0 ? CARD_MODELS.map(([name, id]) => {
        const p = priceOf(id, view.tokens)
        if (!p) return null
        const warm = (view.tokens * p[0]) / 1e6
        const cold = (view.tokens * p[1]) / 1e6
        return (
          <Box key={`m-${name}`} flexDirection="row" flexShrink={0} marginRight={3}>
            <Text size={SIZE} color={name === mine ? TEXT : MUTED} bold>{name}{name === mine ? ' (YOU)' : ''} </Text>
            <Text size={SIZE} color={HUE.warm}>{fmtUsd(warm)}</Text>
            <Text size={SIZE} color={MUTED}> warm / </Text>
            <Text size={SIZE} color={HUE.cold}>{fmtUsd(cold)}</Text>
            <Text size={SIZE} color={MUTED}> cold</Text>
          </Box>
        )
      }) : []
      const keep = s.deadline ? (statusText(s, now) ?? 'keepwarm on') : s.stopped ? `keepwarm stopped: ${s.stopped}` : 'keepwarm off: pings the cache every 50 idle minutes so a break does not cost a rewrite'
      const paid = s.misses.reduce((a, m) => a + (m.usd ?? 0), 0)
      card = (
        <Box key="card" flexDirection="column" paddingX={1} paddingBottom={1}>
          {pending ? <Text size={SIZE} color={MUTED}>{pending}</Text> : null}
          {prices.length ? <Box flexDirection="row" flexWrap="wrap"><Text size={SIZE} color={MUTED}>Next message · {short(view.tokens)} tokens  </Text>{prices}</Box> : null}
          <Box flexDirection="row" alignItems="center" flexWrap="wrap">
            <Text size={SIZE} color={s.deadline ? GREEN : MUTED}>♨ {keep}  </Text>
            {s.deadline
              ? <Button key="kw-off" label="Stop keepwarm" hotkey="k" onPress={() => stop($, s, null)} />
              : view.mode === 'cold'
                ? null
                : <Button key="kw-on" label="Keep warm 6h" hotkey="k" onPress={() => startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)} />}
          </Box>
          {verdict ? <Text size={SIZE} color={verdict.worth ? MUTED : TONE.fast}>  {verdictLine(verdict, verdict.open ? s.every : PING_AFTER_MS)}</Text> : null}
          <Box flexDirection="row" alignItems="center" flexWrap="wrap">
            <Text size={SIZE} color={s.note ? GREEN : MUTED}>✎ handoff {handoffLine(s, now)}  </Text>
            {s.note
              ? <Button key="handoff" label="Clear and continue" hotkey="h" onPress={() => { void $.command.run({ command: 'handoff' }) }} />
              : s.lastRequestAt && !s.compacted && !s.noteWriting
                ? <Button key="handoff-now" label="Write note now" hotkey="n" onPress={() => { void $.command.run({ command: 'handoff', args: 'now' }) }} />
                : null}
          </Box>
          <Text size={SIZE} color={MUTED}>guard {s.guard === 'refuse' ? 'stops a cold send once (resend to pay)' : 'shows the price and sends'} · {s.misses.length} cold write{s.misses.length === 1 ? '' : 's'} paid this session, {fmtUsd(paid)}</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" backgroundColor={BG}>
          {row}
          {card}
        </Box>
        {below}
      </Box>
    )
  })
}
