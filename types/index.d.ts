/** Whether the cache card is open, remembered only for the cache state it was set in. */
export type Fold = { mode: 'warm' | 'cold' | 'none'; open: boolean }

/**
 * The agents sidebar: the agent open in its detail view (null for the list), the one whose Stop is armed, whether the
 * compact Done group is open, what the calls section counts (this turn or the whole session) and the tool row it has open.
 * The last two are optional: a view saved by an earlier version has neither.
 */
export type AgentsView = { detail: string | null; armed: string | null; doneOpen: boolean; callsScope?: 'turn' | 'session'; openTool?: string | null }

declare module 'claude-code' {
  interface PluginState {
    'horizon': { fold: Fold | null; agentsView: AgentsView }
  }
}
