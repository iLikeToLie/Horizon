import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, On, RenderPropsOf } from 'claude-code'
import { clip, groupOf, tallyCalls } from '../hooks/agents'
import type { Entry } from '../hooks/agents'

const MIN = 60_000
const NOW = Date.parse('2099-01-03T12:00:00Z')
const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 12, bodyColumns: 140, scroll: { offset: 0, bodyRows: 12 }, view: {},
}
const PANE = {
  plugin: 'horizon',
  component: 'Pane',
  requestId: 'horizon-agents',
  props: { title: 'Agents', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const agent = (id: string, description: string, type: string, status: AgentInfo['status'], over: Partial<AgentInfo> = {}) => ({
  id, description, type, status, taskStatus: status === 'running' ? 'running' : 'completed', kind: 'local_agent', label: description,
  startTime: NOW - 3 * MIN, cwd: '/work', tokenCount: 0, tokenSamples: [], ...over,
}) as AgentInfo

// The engine beneath the mod: the agents the test sets, and every pane, view, toast and stop it is asked for.
function world(on: On, list: () => AgentInfo[], opts: { stop?: () => { deny: string } | { result: object }; unplaced?: string } = {}) {
  mock.store(on)
  const gate = { wait: null as Promise<void> | null }
  const up = new Set<string>()
  const seen = { gate, toasts: [] as string[], opened: [] as string[], closed: [] as string[], stopped: [] as string[], viewed: [] as Array<string | undefined>, logs: [] as string[], panesAsked: 0, up }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: 'S1' }))
  on('session.model', () => ({ value: 'claude-fable-5-1' }))
  on('session.usage', () => ({ value: { startedAt: NOW - 60 * MIN, context: { window: 1000000, tokens: 200000 }, rateLimits: [], cost: { usd: 1 } } }))
  on('agent.list', () => ({ value: list() }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: [] }))
  on('classic.SessionStart', () => ({}))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] }
  })
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }], tokensAfter: 1000 }))
  on('ui.log', ($, e) => { seen.logs.push(e.text); return { value: undefined } })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => { seen.toasts.push(e.text); return { value: undefined } })
  on('ui.panes', () => { seen.panesAsked++; return { value: [...up].map(id => ({ id, title: 'Agents', isShown: true, isFocused: false, isPlaced: true })) } })
  on('ui.open', ($, e) => {
    seen.opened.push(e.id)
    if (opts.unplaced) return { value: { isPlaced: false as const, reason: opts.unplaced } }
    up.add(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => { up.delete(e.id); seen.closed.push(e.id); return { value: undefined } })
  on('ui.view', ($, e) => {
    seen.viewed.push(e.agentId)
    return { value: {} }
  })
  on('ui.render', ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', async ($, e) => {
    await gate.wait
    if (e.tool === 'Bash' && e.command === 'explode') throw new Error('boom')
    if (e.tool === 'Edit' && e.file_path === 'denied') return { deny: 'no' }
    if (e.tool !== 'TaskStop') return { result: {} }
    seen.stopped.push(String(e.task_id))
    return opts.stop?.() ?? { result: {} }
  })
  return seen
}

const textOf = (node: unknown) => JSON.stringify(node)
const command = (args: string) => ({ command: 'horizon', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } })

/** The roster as the sidebar sees it: one running explorer with a running child, one finished planner. */
const ROSTER = () => [
  agent('a1', 'find auth code', 'Explore', 'running', { model: 'claude-sonnet-5-5', tokenCount: 12000 }),
  agent('a2', 'write tests', 'general-purpose', 'running', { parentId: 'a1', startTime: NOW - 2 * MIN }),
  agent('a3', 'design schema', 'Plan', 'completed', { startTime: NOW - 3 * MIN }),
]

async function start($: Engine, clock: ReturnType<typeof mock.clock>, surface: 'desktop' | 'terminal') {
  await $.session.start({ surface, isInteractive: true, cwd: '/work' })
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(MIN)
}

test('clicking the agents segment opens the pane on the desktop and clicking it again closes it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = world(on, ROSTER)
  await start($, clock, 'desktop')
  const band = await $.ui.mount({ plugin: 'horizon', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  const seg = textOf(await band.find({ key: 'agents' }))
  expect(seg).toContain('2 running')
  // Click only: no hover overlay, and nothing opened by itself.
  expect(seg).not.toContain('hover')
  expect(seen.opened).toEqual([])
  await band.press({ key: 'horizon-agents' })
  expect(seen.opened).toEqual(['horizon-agents'])
  await band.press({ key: 'horizon-agents' })
  expect(seen.closed).toEqual(['horizon-agents'])
  await band.unmount()
})

test('on the terminal clicking the segment opens the pane too, and /horizon agents does the same', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = world(on, ROSTER)
  await start($, clock, 'terminal')
  const band = await $.ui.mount({ plugin: 'horizon', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  // A focused band opens it with `a`.
  expect((await band.find({ key: 'horizon-agents' }))?.props.hotkey).toBe('a')
  await band.press({ key: 'horizon-agents' })
  expect(seen.opened).toEqual(['horizon-agents'])
  expect(seen.toasts).toEqual([])
  await band.press({ key: 'horizon-agents' })
  expect(seen.closed).toEqual(['horizon-agents'])
  const r = await $.command.run(command('agents'))
  expect(r.text).toContain('opened')
  expect(seen.opened).toEqual(['horizon-agents', 'horizon-agents'])
  await band.unmount()
})

test('inline placement draws the compact form: a line an agent, Done collapsed, no timeline', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on, ROSTER)
  await start($, clock, 'terminal')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, placement: 'inline', bodyColumns: 60 } })
  const all = textOf(await ui.find({ type: 'Box' }))
  expect(all).toContain('✻ Agents')
  expect(all).toContain('2 running · 1 done')
  expect(all).toContain('Explore(find auth code)')
  expect(all).toContain('general-purpose(write tests)')
  expect(all).toContain('Done (1)')
  expect(all).not.toContain('Plan(design schema)')
  expect(all).not.toContain('timeline')
  expect(all).not.toContain('Running…')
  expect(await ui.find({ key: 'lane:a1' })).toBeUndefined()
  // Pressing Done expands it.
  await ui.press({ key: 'done-toggle' })
  expect(textOf(await ui.find({ type: 'Box' }))).toContain('Plan(design schema)')
  await ui.unmount()
})

test('inline placement caps the rows and keeps a row to one line', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const many = Array.from({ length: 11 }, (_, i) => agent(`m${i}`, `job ${i} ${'x'.repeat(60)}`, 'Explore', 'running'))
  world(on, () => many)
  await start($, clock, 'terminal')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, placement: 'inline', bodyColumns: 40 } })
  const all = textOf(await ui.find({ type: 'Box' }))
  expect(all).toContain('+3 more')
  expect(all).toContain('…')
  expect(all).not.toContain('x'.repeat(40))
  await ui.unmount()
})

test('dock placement on the terminal draws the full form, timeline included', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on, ROSTER)
  await start($, clock, 'terminal')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = textOf(await ui.find({ type: 'Box' }))
  expect(all).toContain('Running…')
  expect(all).toContain('Done (1)')
  expect(all).toContain('timeline')
  expect(await ui.find({ key: 'lane:a1' })).toBeDefined()
  await ui.unmount()
})

test('hotkeys: b goes back, o opens the transcript, s stops; the compact detail keeps the last 5 calls', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = world(on, ROSTER)
  await start($, clock, 'terminal')
  for (let i = 0; i < 7; i++) await $.tool.call({ tool: 'Grep', pattern: `p${i}`, agentId: 'a1' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, placement: 'inline', bodyColumns: 60 } })
  await ui.press({ key: 'row:a1' })
  const all = textOf(await ui.find({ type: 'Box' }))
  expect(all).toContain('◂ Agents')
  expect(all).not.toContain('Recent calls')
  expect(all).toContain('p6')
  expect(all).toContain('p2')
  expect(all).not.toContain('"p1"')
  expect((await ui.find({ key: 'back' }))?.props.hotkey).toBe('b')
  expect((await ui.find({ key: 'open' }))?.props.hotkey).toBe('o')
  expect((await ui.find({ key: 'stop' }))?.props.hotkey).toBe('s')
  await ui.press({ key: 'open' })
  expect(seen.viewed).toEqual(['a1'])
  await ui.press({ key: 'back' })
  expect(textOf(await ui.find({ type: 'Box' }))).toContain('Done (1)')
  await ui.unmount()
})

test('/horizon agents opens the pane on the desktop, even with no agent, and says "No agents yet"', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = world(on, () => [])
  await start($, clock, 'desktop')
  expect((await $.command.run(command('agents'))).text).toContain('opened')
  expect(seen.opened).toEqual(['horizon-agents'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(textOf(await ui.find({ type: 'Text', text: /No agents yet/ }))).toContain('No agents yet')
  await ui.unmount()
})

test('/horizon agents says so when the pane could not be placed, with the engine\'s reason', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on, () => [], { unplaced: 'no room' })
  await start($, clock, 'desktop')
  const text = (await $.command.run(command('agents'))).text
  expect(text).toContain('could not be opened: no room')
  expect(text).not.toContain('opened;')
})

test('the list nests children under their parent and keeps the finished ones in a Done group', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on, ROSTER)
  await start($, clock, 'desktop')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const all = textOf(await ui.find({ type: 'Box' }))
  expect(all).toContain('✻ Agents')
  expect(all).toContain('2 running · 1 done')
  expect(all).toContain('Explore(find auth code)')
  expect(all).toContain('Running…')
  // The child sits after its parent, indented a level.
  expect(all.indexOf('general-purpose(write tests)')).toBeGreaterThan(all.indexOf('Explore(find auth code)'))
  expect(all).toContain('"  "')
  // Model and tokens on the second line; the finished one under a dim Done (1).
  expect(all).toContain('claude-sonnet-5-5 · 12k tokens')
  expect(all).toContain('Done (1)')
  expect(all.indexOf('Plan(design schema)')).toBeGreaterThan(all.indexOf('Done (1)'))
  expect(await ui.find({ key: 'row:a3' })).toBeDefined()
  await ui.unmount()
})

test('the timeline has a lane and a bar per agent, with its duration', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on, ROSTER)
  await start($, clock, 'desktop')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(textOf(await ui.find({ type: 'Text', text: /timeline/ }))).toContain('timeline')
  for (const id of ['a1', 'a2', 'a3']) {
    const lane = textOf(await ui.find({ key: `lane:${id}` }))
    expect(lane).toContain('━')
  }
  // The running explorer started 3 minutes before the clock's start and 1 minute has run since.
  expect(textOf(await ui.find({ key: 'lane:a1' }))).toContain('4m')
  await ui.unmount()
})

test('a tool call shows as the agent\'s current line and an agent that left the list is taken as done', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let list = ROSTER()
  const seen = world(on, () => list)
  await start($, clock, 'desktop')
  let release = () => {}
  seen.gate.wait = new Promise<void>(resolve => { release = resolve })
  const pending = $.tool.call({ tool: 'Grep', pattern: 'session', path: 'src/', agentId: 'a1' })
  await clock.advance(10)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Grep "session" in src\// }))?.text).toContain('⎿  Grep "session" in src/')
  release()
  await pending
  await ui.unmount()
  // The engine drops a finished agent from its list: the sidebar keeps it, as done.
  list = [list[0] as AgentInfo, list[2] as AgentInfo]
  await clock.advance(MIN)
  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(textOf(await again.find({ type: 'Box' }))).toContain('Done (2)')
  await again.unmount()
})

test('a row opens the detail view with the agent\'s facts, and back returns to the list', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let list: AgentInfo[] = []
  const seen = world(on, () => list)
  await start($, clock, 'desktop')
  // The prompt the main loop gave the Agent call is shown as the task, once the agent is in the list.
  await $.tool.call({ tool: 'Agent', description: 'find auth code', prompt: 'Find where sessions are validated.' })
  list = ROSTER()
  await clock.advance(MIN)
  await $.tool.call({ tool: 'TodoWrite', agentId: 'a1', todos: [{ content: 'Read auth', status: 'in_progress', activeForm: 'Reading auth' }, { content: 'Report', status: 'pending', activeForm: 'Reporting' }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'row:a2' })
  let all = textOf(await ui.find({ type: 'Box' }))
  expect(all).toContain('◂ Agents')
  expect(all).toContain('general-purpose(write tests)')
  expect(all).toContain('parent: find auth code')
  expect(all).not.toContain('Done (')
  await ui.press({ key: 'back' })
  expect(textOf(await ui.find({ type: 'Box' }))).toContain('Done (1)')
  await ui.press({ key: 'row:a1' })
  all = textOf(await ui.find({ type: 'Box' }))
  expect(all).toContain('Find where sessions are validated.')
  expect(all).toContain('◐ Reading auth')
  expect(all).toContain('☐ Report')
  expect(all).toContain('Recent calls')
  expect(all).toContain('TodoWrite')
  await ui.press({ key: 'open' })
  expect(seen.viewed).toEqual(['a1'])
  // A finished agent has no Stop.
  await ui.press({ key: 'back' })
  await ui.press({ key: 'row:a3' })
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  await ui.unmount()
})

test('Stop takes two presses: the first arms it for three seconds, the second calls TaskStop', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = world(on, ROSTER)
  await start($, clock, 'desktop')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'row:a1' })
  expect((await ui.find({ key: 'stop' }))?.props.label).toBe('■ Stop')
  await ui.press({ key: 'stop' })
  expect((await ui.find({ key: 'stop' }))?.props.label).toBe('■ Stop? press again')
  expect(seen.stopped).toEqual([])
  // Left alone, it disarms.
  await clock.advance(3100)
  expect((await ui.find({ key: 'stop' }))?.props.label).toBe('■ Stop')
  await ui.press({ key: 'stop' })
  await ui.press({ key: 'stop' })
  expect(seen.stopped).toEqual(['a1'])
  expect(seen.toasts.some(t => t.includes('stopped find auth code'))).toBe(true)
  expect((await ui.find({ key: 'stop' }))?.props.label).toBe('■ Stop')
  await ui.unmount()
})

test('a refused stop toasts the reason', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = world(on, ROSTER, { stop: () => ({ deny: 'not allowed here' }) })
  await start($, clock, 'desktop')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'row:a2' })
  await ui.press({ key: 'stop' })
  await ui.press({ key: 'stop' })
  expect(seen.stopped).toEqual(['a2'])
  expect(seen.toasts.some(t => t.includes('could not stop write tests') && t.includes('not allowed here'))).toBe(true)
  await ui.unmount()
})

test('an agent that comes back to the list after a gap runs on, its time no longer frozen', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const full = ROSTER()
  let list = full
  world(on, () => list)
  await start($, clock, 'desktop')
  // The engine leaves a1 out of one refresh: the sidebar takes it as done.
  list = [full[1] as AgentInfo, full[2] as AgentInfo]
  await clock.advance(MIN)
  list = full
  await clock.advance(MIN)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const row = textOf(await ui.find({ key: 'row:a1' }))
  expect(row).toContain('Running…')
  const before = row.match(/(\d+m\d+s)/)?.[1]
  await ui.unmount()
  await clock.advance(MIN)
  const later = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(textOf(await later.find({ key: 'row:a1' })).match(/(\d+m\d+s)/)?.[1]).not.toBe(before)
  await later.unmount()
})

test('overlapping calls: the line shows the call still running when the newer one ends first', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = world(on, ROSTER)
  await start($, clock, 'desktop')
  let releaseA = () => {}
  let releaseB = () => {}
  seen.gate.wait = new Promise<void>(resolve => { releaseA = resolve })
  const a = $.tool.call({ tool: 'Grep', pattern: 'first', agentId: 'a1' })
  await clock.advance(10)
  seen.gate.wait = new Promise<void>(resolve => { releaseB = resolve })
  const b = $.tool.call({ tool: 'Grep', pattern: 'second', agentId: 'a1' })
  await clock.advance(10)
  releaseB()
  await b
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /⎿  Grep "first"/ }))?.text).toContain('Grep "first"')
  await ui.unmount()
  releaseA()
  await a
  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await after.find({ type: 'Text', text: /⎿  Grep/ })).toBeUndefined()
  await after.unmount()
})

test('a call that throws leaves no stuck current line', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on, ROSTER)
  await start($, clock, 'desktop')
  await $.tool.call({ tool: 'Bash', command: 'explode', agentId: 'a1' }).catch(() => undefined)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /⎿  Bash/ })).toBeUndefined()
  await ui.unmount()
})

test('clip gives nothing at no room and never overflows', () => {
  expect(clip('Grep something long', 0)).toBe('')
  expect(clip('Grep something long', -3)).toBe('')
  expect(clip('Grep something long', 1)).toBe('…')
  expect(clip('Grep something long', 6)).toBe('Grep …')
  expect(clip('short', 10)).toBe('short')
})

test('a start time past now (clock skew) still draws its timeline lane', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on, () => [...ROSTER(), agent('a4', 'from the future', 'Explore', 'running', { startTime: NOW + 30 * MIN })])
  await start($, clock, 'desktop')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'lane:a4' })).toBeDefined()
  await ui.unmount()
})

test('idle agents get their own count in the header', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on, () => [...ROSTER(), agent('a5', 'teammate', 'teammate', 'idle', { taskStatus: 'running' })])
  await start($, clock, 'desktop')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(textOf(await ui.find({ type: 'Box' }))).toContain('2 running · 1 idle · 1 done')
  await ui.unmount()
})

test('the open pane keeps its clocks running without a tool call', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on, ROSTER)
  await start($, clock, 'desktop')
  await $.command.run(command('agents'))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const age = async () => textOf(await ui.find({ key: 'row:a1' })).match(/Running… (\d+m\d+s)/)?.[1]
  const before = await age()
  await clock.advance(3000)
  const after = await age()
  expect(before).toBe('4m00s')
  expect(after).toBe('4m03s')
  await ui.unmount()
})

test('the open pane picks up a new agent within a few seconds, with no tool call to prompt it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let list = ROSTER()
  world(on, () => list)
  await start($, clock, 'desktop')
  await $.command.run(command('agents'))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'row:a9' })).toBeUndefined()
  list = [...list, agent('a9', 'late starter', 'Explore', 'running', { startTime: NOW + MIN })]
  await clock.advance(5000)
  expect(await ui.find({ key: 'row:a9' })).toBeDefined()
  await ui.unmount()
})

test('the beat stops once the pane is closed', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = world(on, ROSTER)
  await start($, clock, 'desktop')
  await $.command.run(command('agents'))
  await clock.advance(5000)
  // Closed by the person (Esc or the frame's ✕), not by our toggle: the next sync sees it gone and stops.
  seen.up.delete('horizon-agents')
  await clock.advance(5000)
  const asked = seen.panesAsked
  await clock.advance(20_000)
  expect(seen.panesAsked).toBe(asked)
})

test('in a narrow dock a long agent name is cut to one line, and the header leaves closing to the frame', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on, () => [agent('c1', 'Codex: implement Open Waters recorder', 'codex:codex-rescue', 'running')])
  await start($, clock, 'desktop')
  const columns = 44
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: columns } })
  const label = String((await ui.find({ key: 'row:c1' }))?.props.label)
  expect(label).toContain('…')
  expect(label).toContain('Running…')
  expect(label.length).toBeLessThanOrEqual(columns)
  expect(await ui.find({ key: 'close' })).toBeUndefined()
  await ui.unmount()
})

// One request of a turn, the main loop's (no agentId) or an agent's.
async function step($: Engine, index: number, agentId?: string) {
  for await (const _ of $.turn.step({ turnId: 't', index, messageCount: 10, model: 'claude-fable-5-1', agentId } as never)) { /* drain */ }
}

test('calls fold MCP tools by server and skills by name, most used first', () => {
  expect(groupOf('mcp__github__get_me', {})).toEqual({ group: 'mcp', sub: 'github' })
  expect(groupOf('Skill', { skill: 'code-review' })).toEqual({ group: 'skill', sub: 'code-review' })
  expect(groupOf('Bash', {})).toEqual({ group: 'Bash' })
  const e = (group: string, state: Entry['state'], sub?: string) => ({ id: 'x', tool: group, group, sub, text: '', at: 0, state })
  const rows = tallyCalls([e('Read', 'ok'), e('Bash', 'ok'), e('Bash', 'failed'), e('Bash', 'running'), e('mcp', 'ok', 'slack'), e('mcp', 'ok', 'github'), e('mcp', 'ok', 'github')])
  expect(rows.map(r => r.group)).toEqual(['Bash', 'mcp', 'Read'])
  expect(rows[0]).toMatchObject({ n: 3, failed: 1, running: 1 })
  expect(rows[1]?.subs).toEqual(['github', 'slack'])
})

test('the dock has a calls section for this turn, with failures; t switches to the session and a row opens on its calls', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on, ROSTER)
  await start($, clock, 'terminal')
  // A call in an earlier turn, then a new turn.
  await $.tool.call({ tool: 'Read', file_path: 'old.ts' })
  await clock.advance(1000)
  await step($, 0)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'a1' })
  await $.tool.call({ tool: 'Edit', file_path: 'a.ts' })
  await $.tool.call({ tool: 'Edit', file_path: 'denied' })
  await $.tool.call({ tool: 'Skill', skill: 'code-review' })
  await $.tool.call({ tool: 'mcp__github__get_me' })
  await $.tool.call({ tool: 'Bash', command: 'explode' }).catch(() => {})
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  let all = textOf(await ui.find({ type: 'Box' }))
  expect(all).toContain('── calls')
  expect(textOf(await ui.find({ key: 'tool:Bash' }))).toContain('3')
  expect(textOf(await ui.find({ key: 'tool:Edit' }))).toContain('1 ✗')
  expect(textOf(await ui.find({ key: 'tool:skill' }))).toContain('code-review')
  expect(textOf(await ui.find({ key: 'tool:mcp' }))).toContain('github')
  // This turn only: the earlier Read is not counted.
  expect(await ui.find({ key: 'tool:Read' })).toBeUndefined()
  expect(all).toMatch(/✓ 5 ok.*✗ 2 failed/)
  // The receipt: one edit, two errors, while the turn runs.
  expect(all).toMatch(/turn ✶ [^"]*1 edit · 2 errors/)
  // A row opens on its calls, each with who made it.
  await ui.press({ key: 'tool:Bash' })
  all = textOf(await ui.find({ type: 'Box' }))
  expect(all).toContain('npm test')
  expect(all).toContain('find auth code')
  expect(all).toContain('main')
  expect((await ui.find({ key: 'scope' }))?.props.hotkey).toBe('t')
  await ui.press({ key: 'scope' })
  expect(textOf(await ui.find({ key: 'tool:Read' }))).toContain('1')
  await ui.unmount()
})

test('agent steps show on the row, a compaction shows under Loops, and a skill call marks its agent\'s lane', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on, ROSTER)
  await start($, clock, 'desktop')
  await step($, 0, 'a1')
  await step($, 1, 'a1')
  await $.tool.call({ tool: 'Skill', skill: 'simplify', agentId: 'a1' })
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'a', toolUses: [] }] } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const all = textOf(await ui.find({ type: 'Box' }))
  expect(all).toContain('12k tokens · 2 steps')
  expect(all).toContain('compaction ⟲')
  expect(textOf(await ui.find({ key: 'lane:a1' }))).toContain('◆')
  expect(all).toContain('simplify')
  await ui.unmount()
})

test('the turn receipt stops its clock when the turn completes', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on, ROSTER)
  await start($, clock, 'desktop')
  await step($, 0)
  await clock.advance(90_000)
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't', reason: 'answer' })
  await clock.advance(MIN)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const all = textOf(await ui.find({ type: 'Box' }))
  expect(all).toContain('turn 1m30s')
  expect(all).not.toContain('turn ✶')
  await ui.unmount()
})
