/** Whether the cache card is open, remembered only for the cache state it was set in. */
export type Fold = { mode: 'warm' | 'cold' | 'none'; open: boolean }

/** The agents sidebar: the agent open in its detail view (null for the list), and the one whose Stop is armed. */
export type AgentsView = { detail: string | null; armed: string | null }

declare module 'claude-code' {
  interface PluginState {
    'horizon': { fold: Fold | null; agentsView: AgentsView }
  }
}
