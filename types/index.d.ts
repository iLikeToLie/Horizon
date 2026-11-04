/** Whether the cache card is open, remembered only for the cache state it was set in. */
export type Fold = { mode: 'warm' | 'cold' | 'none'; open: boolean }

declare module 'claude-code' {
  interface PluginState {
    'horizon': { fold: Fold | null }
  }
}
