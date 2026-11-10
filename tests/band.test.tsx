import { expect, mock, test } from 'claude-code/testing'
import type { AgentInfo, CommandRunInput, EngineInterface, ModelForkResult, On, RenderPropsOf, TurnCompleteInput, TurnUsage } from 'claude-code'

const MIN = 60_000
const HOUR = 60 * MIN
const NOW = Date.parse('2099-01-03T12:00:00Z')
const LIMITS = [
  { kind: 'five_hour', percentUsed: 38, resetsAt: '2099-01-03T14:00:00Z' },
  { kind: 'seven_day', percentUsed: 20, resetsAt: '2099-01-07T12:00:00Z' },
]
const PROPS: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 140, scroll: { offset: 0, bodyRows: 12 }, view: {},
}

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 200000, cache_creation_input_tokens: 500, model: 'claude-fable-5-1', ...over,
})
let turns = 0
const turn = (): TurnCompleteInput => ({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't' + ++turns, reason: 'answer', usage: usage() })

// The engine beneath the mod: a live context of 200k tokens, two limits, a cost that grows per turn.
function world(on: On, opts: { copies?: boolean; fork?: () => ModelForkResult; agents?: () => AgentInfo[]; steps?: TurnUsage[] } = {}) {
  mock.store(on)
  const seen = { forks: 0, toasts: [] as string[], logs: [] as string[], entered: [] as string[], commands: [] as string[], filled: [] as string[], copied: [] as string[] }
  let cost = 1
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: 'S1' }))
  on('session.model', () => ({ value: 'claude-fable-5-1' }))
  on('session.usage', () => ({ value: { startedAt: NOW - HOUR, context: { window: 1000000, tokens: 200000 }, rateLimits: LIMITS, cost: { usd: (cost += 0.5) } } }))
  on('agent.list', () => ({ value: opts.agents?.() ?? [] }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: [] }))
  on('command.run', { command: 'clear' }, ($, e) => { seen.commands.push(e.command); return {} })
  on('prompt.fill', ($, e) => { seen.filled.push(e.text); return { isFilled: true, text: e.text, cursor: e.text.length } })
  on('ui.copy', ($, e) => { seen.copied.push(e.text); return { value: opts.copies === false ? { isCopied: false as const, reason: 'no-clipboard' as const } : { isCopied: true as const } } })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], usage: opts.steps?.shift() }
  })
  on('prompt.submit', ($, e) => { seen.entered.push(e.text); return { text: e.text } })
  on('classic.SessionStart', () => ({}))
  on('ui.log', ($, e) => { seen.logs.push(e.text); return { value: undefined } })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => { seen.toasts.push(e.text); return { value: undefined } })
  on('ui.render', ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('model.fork', () => {
    seen.forks++
    return { value: opts.fork?.() ?? { isAnswered: true, text: 'warm', usage: usage({ cache_creation_input_tokens: 0 }) } }
  })
  return seen
}

const cmd = (command: string, args: string): CommandRunInput => ({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

const textOf = (node: unknown) => JSON.stringify(node)

test('a warm cache: weather, pace-colored usage bars, the WARM chip and its time left', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.complete(turn())
  await clock.advance(18 * MIN)
  const band = await $.ui.mount({ plugin: 'horizon', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  const all = textOf(await band.find({ key: 'row' }))
  expect(all).toContain('200k')
  // 5H: 38% used with 3h18 of 5 hours gone (66%): green, solid to 38%, the margin dashed grey; on pace for 58% at reset.
  expect(all).toContain('38%')
  expect(all).toContain('━━━━')
  expect(all).toContain('→ 58% at reset')
  expect(all).toContain('20%')
  expect(all).toContain(' WARM ')
  expect(all).toContain('42m left')
  // Warm starts folded.
  expect(await band.find({ key: 'card' })).toBeUndefined()
  expect((await band.find({ key: 'horizon-fold' }))?.props.label).toBe('Show')
  await band.press({ key: 'horizon-fold' })
  expect(textOf(await band.find({ key: 'card' }))).toContain('Keep warm 6h')
  // Hide folds it again, and Show reopens it.
  await band.press({ key: 'horizon-fold' })
  expect(await band.find({ key: 'card' })).toBeUndefined()
  expect((await band.find({ key: 'horizon-fold' }))?.props.label).toBe('Show')
  await band.press({ key: 'horizon-fold' })
  expect(await band.find({ key: 'card' })).toBeDefined()
  await band.unmount()
})

test('past the hour: COLD with the rewrite price, the send refused once, the resend paid', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = world(on)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.command.run(cmd('horizon', 'handoff off'))
  await $.turn.complete(turn())
  await clock.advance(2 * HOUR)
  const band = await $.ui.mount({ plugin: 'horizon', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  const row = textOf(await band.find({ key: 'row' }))
  expect(row).toContain(' COLD ')
  // 200k tokens at Fable 5.1's $20/MTok 1h write.
  expect(row).toContain('$4.00')
  // Cold opens the card.
  expect(await band.find({ key: 'card' })).toBeDefined()

  const first = await $.prompt.submit({ text: 'recap please', wait: false, origin: { kind: 'composer' } })
  expect('drop' in first && first.drop).toContain('went cold')
  expect(seen.entered).toEqual([])
  await $.prompt.submit({ text: 'recap please', wait: false, origin: { kind: 'composer' } })
  expect(seen.entered).toEqual(['recap please'])
  await band.unmount()
})

test('the handoff note is written over the warm cache before it lapses, and /handoff clears and copies it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = world(on, {
    fork: () => ({ isAnswered: true, text: 'Continuing from a previous conversation: fix the parser.', usage: usage({ cache_creation_input_tokens: 100, output_tokens: 300 }) }),
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.complete(turn())
  await clock.advance(45 * MIN)
  expect(seen.forks).toBe(0)
  await clock.advance(7 * MIN)
  expect(seen.forks).toBe(1)
  // Once per idle stretch.
  await clock.advance(5 * MIN)
  expect(seen.forks).toBe(1)
  expect((await $.command.run(cmd('handoff', 'show'))).text).toContain('fix the parser')
  await $.command.run(cmd('handoff', ''))
  await clock.advance(100)
  expect(seen.logs).toEqual([])
  expect(seen.commands).toEqual(['clear'])
  expect(seen.copied[0]).toContain('fix the parser')
  expect(seen.filled).toEqual([])
})

test('/handoff puts the note in the prompt box when no clipboard takes it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = world(on, {
    copies: false,
    fork: () => ({ isAnswered: true, text: 'Continuing from a previous conversation: fix the parser.', usage: usage({ cache_creation_input_tokens: 100, output_tokens: 300 }) }),
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.complete(turn())
  await clock.advance(52 * MIN)
  await $.command.run(cmd('handoff', ''))
  await clock.advance(100)
  expect(seen.commands).toEqual(['clear'])
  expect(seen.filled[0]).toContain('fix the parser')
  expect(seen.toasts.some(t => t.includes('prompt box instead'))).toBe(true)
})

test('/keepwarm arms a window the band shows, and pings at 50 idle minutes', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = world(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.complete(turn())
  expect((await $.command.run(cmd('keepwarm', '2h'))).text).toContain('keepwarm on for 2h00m')
  const band = await $.ui.mount({ plugin: 'horizon', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(textOf(await band.find({ key: 'row' }))).toContain('♨')
  await clock.advance(51 * MIN)
  expect(seen.forks).toBe(1)
  // Keepwarm holds the cache, so no handoff note is needed.
  expect((await $.command.run(cmd('handoff', 'show'))).text).toContain('No handoff note')
  await band.unmount()
})

test('the terminal has the same card and buttons as the desktop', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.complete(turn())
  await clock.advance(10 * MIN)
  const band = await $.ui.mount({ plugin: 'horizon', surface: 'terminal', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 80 } })
  await band.press({ key: 'horizon-fold' })
  expect(await band.find({ key: 'card' })).toBeDefined()
  await band.press({ key: 'kw-on' })
  expect(textOf(await band.find({ key: 'row' }))).toContain('♨')
  expect(await band.find({ key: 'kw-off' })).toBeDefined()
  await band.unmount()
})

const agent = (id: string, description: string, status: AgentInfo['status']) => ({ id, description, type: 'general-purpose', status }) as AgentInfo

test('/handoff now writes the note at once over the warm cache, in the background, and says when it is ready', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = world(on, {
    fork: () => ({ isAnswered: true, text: 'Continuing from a previous conversation: ship the band.', usage: usage({ cache_creation_input_tokens: 100, output_tokens: 300 }) }),
  })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.complete(turn())
  await clock.advance(5 * MIN)
  const band = await $.ui.mount({ plugin: 'horizon', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  await band.press({ key: 'horizon-fold' })
  expect(await band.find({ key: 'handoff-now' })).toBeDefined()
  expect((await $.command.run(cmd('handoff', 'now'))).text).toContain('Writing a handoff note')
  await clock.advance(100)
  expect(seen.forks).toBe(1)
  expect(seen.toasts.some(t => t.includes('handoff note ready'))).toBe(true)
  expect((await $.command.run(cmd('handoff', 'show'))).text).toContain('ship the band')
  // One note per point of the conversation; the card offers the note instead.
  expect((await $.command.run(cmd('handoff', 'now'))).text).toContain('ready already')
  expect(seen.forks).toBe(1)
  expect(await band.find({ key: 'handoff' })).toBeDefined()
  expect(await band.find({ key: 'handoff-now' })).toBeUndefined()
  // The automatic note does not write a second one for the same turn.
  await clock.advance(50 * MIN)
  expect(seen.forks).toBe(1)
  await band.unmount()
})

test('/handoff now on a cold cache shows the re-write price first, and the second one pays it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = world(on, {
    fork: () => ({ isAnswered: true, text: 'Continuing from a previous conversation: the cold one.', usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000, output_tokens: 300 }) }),
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run(cmd('horizon', 'handoff off'))
  await $.turn.complete(turn())
  await clock.advance(2 * HOUR)
  const first = (await $.command.run(cmd('handoff', 'now'))).text
  expect(first).toContain('went cold')
  expect(first).toContain('$4.0')
  expect(seen.forks).toBe(0)
  expect((await $.command.run(cmd('handoff', 'now'))).text).toContain('Writing a handoff note')
  await clock.advance(100)
  expect(seen.forks).toBe(1)
  // The fork re-wrote the cache: a cold write paid, and the cache warm again.
  const card = (await $.command.run(cmd('horizon', ''))).text
  expect(card).toContain('1 cold write paid')
  expect(card).toContain('state       warm')
})

test('agent names appear only on hover, laid over the agents segment', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let done = false
  world(on, {
    agents: () => [agent('a1', 'code-reviewer', done ? 'completed' : 'running'), agent('a2', 'Explore', done ? 'completed' : 'running')],
  })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.complete(turn())
  await clock.advance(MIN)
  let band = await $.ui.mount({ plugin: 'horizon', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(textOf(await band.find({ key: 'agents' }))).toContain('2 running')
  // The segment is the hover scope; the names sit in it hidden, absolutely placed, shown while it is hovered.
  let seg = textOf(await band.find({ key: 'agents' }))
  expect(seg).toContain('"position":"absolute"')
  expect(seg).toContain('"display":"none"')
  expect(seg).toContain('"hover":{"display":"flex"}')
  expect(seg).toContain('code-reviewer, Explore')
  await band.unmount()
  // Once none runs, the hover names the last ones that ran.
  done = true
  await clock.advance(MIN)
  band = await $.ui.mount({ plugin: 'horizon', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  seg = textOf(await band.find({ key: 'agents' }))
  expect(seg).toContain('ran: code-reviewer, Explore')
  await band.unmount()
})

test('the keepwarm icon says whether the pings left cost less than one cold write', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.complete(turn())
  await clock.advance(MIN)
  // 2h at one ping per 50m: 2 pings of about $0.05 against a $4.00 re-write.
  await $.command.run(cmd('keepwarm', '2h'))
  let band = await $.ui.mount({ plugin: 'horizon', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  let row = textOf(await band.find({ key: 'row' }))
  expect(row).toContain('♨ 2h00m')
  expect(row).not.toContain('♨≥')
  await band.press({ key: 'horizon-fold' })
  expect(textOf(await band.find({ key: 'card' }))).toContain('✓ worth it')
  await band.unmount()
  // A ping every 2 minutes for 6 hours: about 180 pings, more than one re-write.
  await $.command.run(cmd('keepwarm', '6h every 2m'))
  band = await $.ui.mount({ plugin: 'horizon', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  row = textOf(await band.find({ key: 'row' }))
  expect(row).toContain('♨≥')
  expect(textOf(await band.find({ key: 'card' })) + (await $.command.run(cmd('horizon', ''))).text).toContain('not worth it')
  await band.unmount()
})

test('with keepwarm off, a dim ♨ hint shows while the cache is about to lapse', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run(cmd('horizon', 'handoff off'))
  await $.turn.complete(turn())
  await clock.advance(30 * MIN)
  let band = await $.ui.mount({ plugin: 'horizon', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(textOf(await band.find({ key: 'row' }))).not.toContain('♨')
  await band.unmount()
  await clock.advance(22 * MIN)
  band = await $.ui.mount({ plugin: 'horizon', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  // Green (#8fbf6a): a 6h window would cost less than the re-write at stake.
  const row = textOf(await band.find({ key: 'row' }))
  expect(row).toContain(' ♨')
  expect(row).toContain('#8fbf6a')
  expect(row).toContain('at stake')
  await band.unmount()
})

test('once a note was written, a ✎ stays on the band for the session, and /handoff show still prints the last one', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on, {
    fork: () => ({ isAnswered: true, text: 'Continuing from a previous conversation: keep the pencil.', usage: usage({ cache_creation_input_tokens: 100, output_tokens: 300 }) }),
  })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.complete(turn())
  let band = await $.ui.mount({ plugin: 'horizon', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(textOf(await band.find({ key: 'row' }))).not.toContain('✎')
  await band.unmount()
  await $.command.run(cmd('handoff', 'now'))
  await clock.advance(100)
  band = await $.ui.mount({ plugin: 'horizon', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(textOf(await band.find({ key: 'row' }))).toContain('✎ note')
  await band.unmount()
  // The next turn puts the note out of date: the ✎ stays, dim, without "note".
  await $.turn.complete(turn())
  band = await $.ui.mount({ plugin: 'horizon', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  const row = textOf(await band.find({ key: 'row' }))
  expect(row).toContain(' ✎')
  expect(row).not.toContain('✎ note')
  await band.unmount()
  const shown = (await $.command.run(cmd('handoff', 'show'))).text
  expect(shown).toContain('Out of date')
  expect(shown).toContain('keep the pencil')
  // Continuing needs a current note.
  expect((await $.command.run(cmd('handoff', ''))).text).toContain('No handoff note is ready')
})

// One main turn of requests, each answered with the next usage queued in world's steps; the turn reports their sum.
async function multiStep($: EngineInterface, steps: { read: number; write: number; messages: number }[], queue: TurnUsage[]) {
  const id = 't' + ++turns
  const sum = usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0, input_tokens: 0 })
  for (const [index, st] of steps.entries()) {
    const u = usage({ cache_read_input_tokens: st.read, cache_creation_input_tokens: st.write })
    queue.push(u)
    for await (const _ of $.turn.step({ turnId: id, index, messageCount: st.messages, model: 'claude-fable-5-1' } as never)) { /* drain */ }
    sum.cache_read_input_tokens += u.cache_read_input_tokens
    sum.cache_creation_input_tokens += u.cache_creation_input_tokens
    sum.output_tokens += u.output_tokens
    sum.input_tokens += u.input_tokens
  }
  await $.turn.complete({ ...turn(), turnId: id, usage: sum })
}

test('a long warm turn whose small writes add up past half the context is not a cold write', async ($, on) => {
  mock.clock(on, { now: NOW })
  const steps: TurnUsage[] = []
  const seen = world(on, { steps })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run(cmd('horizon', 'handoff off'))
  await $.turn.complete(turn())
  // Every request reads the whole context from the cache; the writes sum to 119k, over half of the 200k the turn started with.
  await multiStep($, [
    { read: 200000, write: 1500, messages: 10 }, { read: 201500, write: 60000, messages: 12 }, { read: 261500, write: 2000, messages: 14 },
    { read: 263500, write: 55000, messages: 16 }, { read: 318500, write: 500, messages: 18 },
  ], steps)
  expect(seen.logs.join('\n')).not.toContain('cold write of')
  expect((await $.command.run(cmd('horizon', ''))).text).not.toContain('cold write paid')
})

test('a request that reads nothing from the cache and writes the context again is one cold write, priced at that request', async ($, on) => {
  mock.clock(on, { now: NOW })
  const steps: TurnUsage[] = []
  const seen = world(on, { steps })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run(cmd('horizon', 'handoff off'))
  await $.turn.complete(turn())
  await multiStep($, [{ read: 0, write: 200000, messages: 10 }, { read: 200000, write: 3000, messages: 12 }], steps)
  // 200k at Fable 5.1's $20/MTok 1h write; the warm request after it is not part of the miss.
  expect(seen.logs.filter(l => l.includes('cold write of'))).toEqual([expect.stringContaining('cold write of 200k tokens paid ($4.00)')])
  expect((await $.command.run(cmd('horizon', ''))).text).toContain('1 cold write paid')
})

test('a compaction mid-turn: only the requests before it are scored', async ($, on) => {
  mock.clock(on, { now: NOW })
  const steps: TurnUsage[] = []
  const seen = world(on, { steps })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run(cmd('horizon', 'handoff off'))
  await $.turn.complete(turn())
  // The summary after the compaction reads nothing and writes a fresh prefix: not a cold write.
  await multiStep($, [{ read: 200000, write: 1000, messages: 40 }, { read: 0, write: 150000, messages: 3 }], steps)
  expect(seen.logs.join('\n')).not.toContain('cold write of')
  // A cold request before the compaction is still paid.
  await multiStep($, [{ read: 0, write: 200000, messages: 10 }, { read: 0, write: 150000, messages: 2 }], steps)
  expect(seen.logs.filter(l => l.includes('cold write of'))).toEqual([expect.stringContaining('cold write of 200k tokens paid')])
})

test('a request that got no response does not move the cache clock, so the ping still lands before the hour', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const steps: TurnUsage[] = []
  const seen = world(on, { steps })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run(cmd('horizon', 'handoff off'))
  await $.turn.complete(turn())
  await $.command.run(cmd('keepwarm', ''))
  await clock.advance(30 * MIN)
  // The API refused the next request (overloaded, or the usage limit): the step got no response and the turn none either.
  for await (const _ of $.turn.step({ turnId: 'failed', index: 0, messageCount: 10, model: 'claude-fable-5-1' } as never)) { /* drain */ }
  await $.turn.complete({ ...turn(), turnId: 'failed', usage: undefined } as unknown as TurnCompleteInput)
  // The cache was last touched 30 minutes ago, not now.
  expect((await $.command.run(cmd('keepwarm', 'status'))).text).toContain('ping in 20m')
  await clock.advance(20 * MIN)
  expect(seen.forks).toBe(1)
})

test('a ping that finds the cache gone pays the re-write once and keeps the window; two in a row stop it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // Cold, then warm (the streak starts again), then cold twice.
  const replies = ['cold', 'warm', 'cold', 'cold']
  const seen = world(on, {
    fork: () => ({
      isAnswered: true,
      text: 'warm',
      usage: replies.shift() === 'cold' ? usage({ cache_read_input_tokens: 30000, cache_creation_input_tokens: 156000 }) : usage({ cache_creation_input_tokens: 0 }),
    }),
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run(cmd('horizon', 'handoff off'))
  await $.turn.complete(turn())
  await $.command.run(cmd('keepwarm', ''))
  const status = async () => (await $.command.run(cmd('keepwarm', 'status'))).text
  await clock.advance(50 * MIN)
  expect(seen.forks).toBe(1)
  // 156k at Fable 5.1's $20/MTok 1h write, paid by the ping: counted, and the cache is warm from it.
  expect(seen.logs.join('\n')).toContain('re-wrote 156k tokens ($3.12)')
  expect(await status()).toContain('ping in 50m')
  let card = (await $.command.run(cmd('horizon', ''))).text
  expect(card).toContain('1 cold write paid')
  expect(card).toContain('state       warm')
  await clock.advance(50 * MIN)
  expect(seen.forks).toBe(2)
  expect(await status()).toContain('ping in 50m')
  await clock.advance(50 * MIN)
  expect(seen.forks).toBe(3)
  expect(await status()).toContain('ping in 50m')
  await clock.advance(50 * MIN)
  expect(seen.forks).toBe(4)
  expect(await status()).toContain('keepwarm stopped: two pings in a row found the cache gone')
  card = (await $.command.run(cmd('horizon', ''))).text
  expect(card).toContain('3 cold writes paid')
  // The last ping's re-write left the cache warm, so the next message is not held as cold.
  expect(card).toContain('state       warm')
})
