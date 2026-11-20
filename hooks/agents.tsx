import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, On, RenderChildren } from 'claude-code'

import type { AgentsView } from '../types'
import { refreshAgents, short, w } from './weather'

// The agents sidebar, a right-hand pane in the desktop app after claude-agentpane's look (dense, one line a row, glyphs,
// monospace) and Apiarius's core (list, org tree, timeline, detail, stop). The band's agents segment opens it; it never
// opens or folds by itself. Colors are theme keys, so it follows the person's theme.

export const PANE = 'horizon-agents'
export const UNAVAILABLE = 'Agents sidebar is available in the desktop app'

const MINUTE = 60_000
const STOP_ARM_MS = 3000
const CALLS_KEPT = 40
const CALLS_SHOWN = 20
const NAME_MAX = 40
const DETAIL_TEXT_MAX = 700

const view = atom({ plugin: 'horizon', key: 'agentsView' } as const, { detail: null, armed: null } as AgentsView)

type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }
type Call = { id: string; tool: string; text: string; at: number }
/** What the pane knows of one agent: the engine's row, merged with what the tool calls and turns told. */
export type Rec = {
  id: string
  name: string
  type: string
  status: AgentInfo['status']
  taskStatus: AgentInfo['taskStatus']
  parentId?: string
  startTime: number
  endTime?: number
  model?: string
  tokens: number
  label: string
  calls: Call[]
  current: Call | null
  todos: Todo[]
  prompt?: string
  result?: string
}

// Every agent seen this session, in the order first seen; one set per loaded module.
const roster = new Map<string, Rec>()
// Prompts of Agent calls not yet matched to a spawned agent, by the call's description.
const prompts = new Map<string, string[]>()
let surface: string | null = null

export function resetAgents() {
  roster.clear()
  prompts.clear()
}

type Kind = 'running' | 'waiting' | 'done' | 'failed'
const TERMINAL = new Set(['completed', 'failed', 'killed'])
const isEnded = (r: Rec) => TERMINAL.has(r.status) || TERMINAL.has(r.taskStatus)
export function kindOf(r: Rec): Kind {
  if (r.status === 'failed' || r.status === 'killed' || r.taskStatus === 'failed' || r.taskStatus === 'killed') return 'failed'
  if (isEnded(r)) return 'done'
  if (r.status === 'waiting' || r.status === 'idle' || r.taskStatus === 'paused') return 'waiting'
  return 'running'
}
const HUE: Record<Kind, string> = { running: 'claude', waiting: 'warning', done: 'success', failed: 'error' }

const nameOf = (a: { description?: string; type?: string; name?: string }) => a.description || a.name || a.type || 'agent'

/** Merges the engine's list into the roster: an agent that left the list unfinished is taken as done, now. */
export function syncAgents(list: readonly AgentInfo[], now: number) {
  const present = new Set<string>()
  for (const a of list) {
    present.add(a.id)
    const was = roster.get(a.id)
    const rec: Rec = was ?? { id: a.id, name: '', type: a.type, status: a.status, taskStatus: a.taskStatus, startTime: a.startTime, tokens: 0, label: '', calls: [], current: null, todos: [] }
    rec.name = nameOf(a)
    rec.type = a.type || rec.type
    rec.status = a.status
    rec.taskStatus = a.taskStatus
    rec.parentId = a.parentId
    rec.startTime = a.startTime || rec.startTime
    rec.model = a.model ?? rec.model
    rec.tokens = a.tokenCount || rec.tokens
    rec.label = a.label && a.label !== a.description ? clip(a.label, 80) : ''
    if (!was) {
      const queued = prompts.get(a.description)
      rec.prompt = queued?.shift()
      roster.set(a.id, rec)
    }
    if (isEnded(rec)) {
      rec.endTime ??= now
      rec.current = null
    }
  }
  for (const rec of roster.values()) {
    if (present.has(rec.id) || isEnded(rec)) continue
    rec.status = 'completed'
    rec.endTime = now
    rec.current = null
  }
}

/** The list from the engine, merged into the roster; true when the band's counts changed. */
export async function refreshRoster($: EngineInterface): Promise<boolean> {
  const changed = await refreshAgents($)
  syncAgents(w.list, await $.clock.now())
  return changed
}

// ---- Time and text. ----

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

const clip = (text: string, max: number) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

/** One line for a tool call, `Grep "session" in src/`: the tool and the first argument that says what it works on. */
function describeCall(e: Record<string, unknown> & { tool: string }): string {
  const arg = ['pattern', 'command', 'file_path', 'path', 'url', 'query', 'description', 'prompt', 'skill', 'task_id'].map(k => e[k]).find(v => typeof v === 'string' && v)
  const where = typeof e.path === 'string' && typeof e.pattern === 'string' ? ` in ${e.path}` : ''
  if (typeof arg !== 'string') return e.tool
  return e.tool === 'Grep' || e.tool === 'Glob' ? `${e.tool} "${clip(arg, 40)}"${where}` : `${e.tool} ${clip(arg, 60)}`
}

// ---- The pane. ----

/** Open the sidebar, or close it when it stands; on any surface but the desktop's a toast says why not. */
export async function toggleAgents($: EngineInterface, from: string | null | undefined, only: 'open' | 'toggle' = 'toggle'): Promise<'opened' | 'closed' | 'unavailable'> {
  if (from !== 'desktop') {
    $.ui.toast(UNAVAILABLE)
    return 'unavailable'
  }
  try {
    const up = (await $.ui.panes()).some(p => p.id === PANE)
    if (up && only === 'toggle') {
      await $.ui.close({ id: PANE })
      return 'closed'
    }
    const opened = await $.ui.open({ id: PANE, title: 'Agents', closeOnEscape: true })
    if (!opened.isPlaced) $.ui.log(`horizon: the agents sidebar could not be placed (${opened.reason})`)
  } catch (err) {
    $.ui.log(`horizon: could not open the agents sidebar (${err instanceof Error ? err.message : String(err)})`)
  }
  return 'opened'
}

/** The surface the session started on, for a command that has none of its own. */
export const sessionSurface = () => surface
export const noteSurface = (from: string | null) => { surface = from }

/** An agent's turn ends with its answer: the result the detail shows. */
export function noteAnswer(agentId: string | undefined, answer: unknown) {
  const rec = agentId ? roster.get(agentId) : undefined
  if (rec && typeof answer === 'string' && answer) rec.result = answer
}

export function registerAgents(on: On) {
  // What each agent is doing: its calls as they start and end, its todo list, and the prompts the main loop hands out.
  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown> & { tool: string; tool_use_id: string; agentId?: string }
    if (input.tool === 'Agent' && typeof input.description === 'string' && typeof input.prompt === 'string') {
      const queue = prompts.get(input.description) ?? []
      queue.push(input.prompt)
      prompts.set(input.description, queue.slice(-5))
    }
    const rec = input.agentId ? roster.get(input.agentId) : undefined
    if (!rec) return next(e)
    const call: Call = { id: input.tool_use_id, tool: input.tool, text: describeCall(input), at: await $.clock.now() }
    rec.current = call
    rec.calls.push(call)
    if (rec.calls.length > CALLS_KEPT) rec.calls = rec.calls.slice(-CALLS_KEPT)
    if (input.tool === 'TodoWrite' && Array.isArray(input.todos)) rec.todos = input.todos as Todo[]
    $.ui.invalidate('ui.render')
    const ran = await next(e)
    if (rec.current?.id === call.id) rec.current = null
    $.ui.invalidate('ui.render')
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const columns = e.props.bodyColumns
    const v = await read($, view)
    const recs = [...roster.values()]
    const byId = new Map(recs.map(r => [r.id, r]))
    const active = recs.filter(r => !isEnded(r))
    const running = recs.filter(r => (kindOf(r) === 'running' || kindOf(r) === 'waiting') && r.status !== 'idle').length
    const done = recs.length - active.length
    const age = (r: Rec) => elapsed((r.endTime ?? now) - r.startTime)
    const dot = (r: Rec, key: string, dim = false) => <Text key={key} color={HUE[kindOf(r)]} dimColor={dim}>⏺</Text>

    const closeButton = <Button key="close" plain role="dismiss" label="×" onPress={() => { void $.ui.close({ id: PANE }) }} />
    const header = (left: RenderChildren) => (
      <Box key="header" flexDirection="row" alignItems="center" marginBottom={1}>
        {left}
        <Box flexGrow={1} />
        <Text key="counts" mono dimColor>{running} running · {done} done </Text>
        {closeButton}
      </Box>
    )
    const go = (detail: string | null) => () => { void update($, view, () => ({ detail, armed: null })) }

    // ---- Detail: one agent. ----
    const one = v.detail ? byId.get(v.detail) : undefined
    if (one) {
      const kind = kindOf(one)
      const parent = one.parentId ? byId.get(one.parentId) : undefined
      const ended = isEnded(one)
      const state = kind === 'running' ? '✶ Running…' : kind === 'waiting' ? '◐ Waiting' : kind === 'failed' ? `✗ ${one.status === 'killed' || one.taskStatus === 'killed' ? 'Stopped' : 'Failed'}` : '✓ Done'
      const facts = [one.model, one.tokens > 0 ? `${short(one.tokens)} tokens` : '', `parent: ${parent ? parent.name : 'main'}`].filter(Boolean).join(' · ')
      const armed = v.armed === one.id
      const calls = one.calls.slice(-CALLS_SHOWN)
      return (
        <Box flexDirection="column">
          {header(<Button key="back" plain label="◂ Agents" onPress={go(null)} />)}
          <Box key="title" flexDirection="row">
            {dot(one, 'd')}
            <Text key="n" mono bold> {one.type}({clip(one.name, NAME_MAX)})</Text>
          </Box>
          <Text key="state" mono color={HUE[kind]}>{state} <Text dimColor>{age(one)}</Text></Text>
          <Text key="facts" mono dimColor>{facts}</Text>
          {one.prompt ? <Box key="prompt" flexDirection="column" marginTop={1}><Text mono dimColor>Task</Text><Text mono>{clip(one.prompt, DETAIL_TEXT_MAX)}</Text></Box> : null}
          {one.todos.length ? (
            <Box key="todos" flexDirection="column" marginTop={1}>
              <Text mono dimColor>Todos</Text>
              {one.todos.map((t, i) => (
                <Text key={`t${i}`} mono dimColor={t.status === 'completed'} color={t.status === 'in_progress' ? 'claude' : undefined}>
                  {t.status === 'completed' ? '☒' : t.status === 'in_progress' ? '◐' : '☐'} {t.status === 'in_progress' ? t.activeForm : t.content}
                </Text>
              ))}
            </Box>
          ) : null}
          {calls.length ? (
            <Box key="calls" flexDirection="column" marginTop={1}>
              <Text mono dimColor>Recent calls</Text>
              {calls.map(c => <Text key={`c-${c.id}`} mono dimColor={one.current?.id !== c.id} wrap="truncate-end">⎿  {c.text}</Text>)}
            </Box>
          ) : null}
          {ended && one.result ? <Box key="result" flexDirection="column" marginTop={1}><Text mono dimColor>Result</Text><Text mono>{clip(one.result, DETAIL_TEXT_MAX)}</Text></Box> : null}
          <Box key="actions" flexDirection="row" marginTop={1}>
            <Button
              key="open"
              plain
              label="Open transcript"
              onPress={() => {
                void $.ui.view({ agentId: one.id }).then(r => { if (r && 'deny' in r && r.deny) $.ui.toast(`horizon: ${r.deny}`) })
              }}
            />
            {ended ? null : (
              <Box key="stop-box" marginLeft={2}>
                <Button key="stop" plain label={armed ? '■ Stop? press again' : '■ Stop'} onPress={() => { void pressStop($, one.id) }} />
              </Box>
            )}
          </Box>
        </Box>
      )
    }

    // ---- List: the tree, running ones first, then the finished ones dimmed. ----
    const kids = new Map<string, Rec[]>()
    const roots: Rec[] = []
    for (const r of recs) {
      if (r.parentId && byId.has(r.parentId)) kids.set(r.parentId, [...(kids.get(r.parentId) ?? []), r])
      else roots.push(r)
    }
    const live = (r: Rec): boolean => !isEnded(r) || (kids.get(r.id) ?? []).some(live)
    const rows: RenderChildren[] = []
    const draw = (r: Rec, depth: number, dim: boolean) => {
      const pad = '  '.repeat(depth)
      const kind = kindOf(r)
      const ended = isEnded(r)
      const status = kind === 'running' ? '✶ Running…' : kind === 'waiting' ? '◐ Waiting' : kind === 'failed' ? '✗' : '✓'
      rows.push(
        <Button key={`row:${r.id}`} plain onPress={go(r.id)}>
          <Text mono>{pad}</Text>
          {dot(r, 'd', dim)}
          <Text mono bold={!dim} dimColor={dim}> {r.type}({clip(r.name, NAME_MAX)})  </Text>
          <Text mono color={HUE[kind]} dimColor={dim && !ended}>{status} </Text>
          <Text mono dimColor>{age(r)}</Text>
        </Button>,
      )
      const detail = r.current ? r.current.text : ended ? '' : r.label
      const extra = [r.model, r.tokens > 0 ? `${short(r.tokens)} tokens` : ''].filter(Boolean).join(' · ')
      if (detail || (extra && !dim)) {
        rows.push(
          <Text key={`sub:${r.id}`} mono dimColor wrap="truncate-end">{pad}  ⎿  {detail}{detail && extra ? '  · ' : ''}{dim ? '' : extra}</Text>,
        )
      }
      for (const c of kids.get(r.id) ?? []) draw(c, depth + 1, dim)
    }
    for (const r of roots.filter(live)) draw(r, 0, false)
    const finished = roots.filter(r => !live(r))
    if (finished.length) {
      rows.push(<Text key="done-head" mono dimColor bold>Done ({done})</Text>)
      for (const r of finished) draw(r, 0, true)
    }

    // ---- Timeline: one lane per agent, from its start to its end (or now), over the window all of them span. ----
    const lanes: RenderChildren[] = []
    if (recs.length) {
      const from = Math.min(...recs.map(r => r.startTime))
      const to = Math.max(now, ...recs.map(r => r.endTime ?? now))
      const span = Math.max(to - from, MINUTE / 6)
      const cells = Math.max(8, Math.min(30, columns - 34))
      const label = Math.max(10, Math.min(20, columns - cells - 14))
      for (const r of [...recs].sort((a, b) => a.startTime - b.startTime)) {
        const a = Math.floor(((r.startTime - from) / span) * cells)
        const b = Math.max(a + 1, Math.ceil((((r.endTime ?? now) - from) / span) * cells))
        const kind = kindOf(r)
        lanes.push(
          <Box key={`lane:${r.id}`} flexDirection="row">
            {dot(r, 'd')}
            <Text key="l" mono> {clip(`${r.type}(${r.name})`, label).padEnd(label)} </Text>
            <Text key="p" mono dimColor>{'·'.repeat(a)}</Text>
            <Text key="b" mono color={HUE[kind]}>{'━'.repeat(Math.min(b, cells) - a)}</Text>
            <Text key="s" mono dimColor>{'·'.repeat(Math.max(0, cells - b))}</Text>
            <Text key="t" mono dimColor> {age(r)}</Text>
          </Box>,
        )
      }
    }

    return (
      <Box flexDirection="column">
        {header(<Text key="title" mono bold color="claude">✻ Agents</Text>)}
        {recs.length === 0 ? <Text key="none" mono dimColor>No agents yet</Text> : null}
        {rows}
        {lanes.length ? <Text key="tl-head" mono dimColor>── timeline {'─'.repeat(Math.max(0, columns - 12))}</Text> : null}
        {lanes}
      </Box>
    )
  })
}

/** The first press arms the stop for a few seconds; the second calls TaskStop. */
async function pressStop($: EngineInterface, id: string) {
  const v = await read($, view)
  if (v.armed !== id) {
    await update($, view, s => ({ ...s, armed: id }))
    $.clock.after(STOP_ARM_MS, () => { void update($, view, s => (s.armed === id ? { ...s, armed: null } : s)) })
    return
  }
  await update($, view, s => ({ ...s, armed: null }))
  const name = roster.get(id)?.name ?? 'agent'
  try {
    const r = await $.tool.call({ tool: 'TaskStop', task_id: id })
    if (r.deny !== undefined) $.ui.toast(`horizon: could not stop ${name}: ${r.deny}`)
    else if (r.isError) $.ui.toast(`horizon: could not stop ${name}: ${r.text ?? 'the tool reported an error'}`)
    else $.ui.toast(`horizon: stopped ${name}`)
  } catch (err) {
    $.ui.toast(`horizon: could not stop ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
  await refreshRoster($)
  $.ui.invalidate('ui.render')
}
