export type SessionRef = { pane: string; tab: string; title: string; status: string; count: number }
export type Issue = { iid: number; title: string; status: string; url: string; updatedAt: string; sessions: SessionRef[] }
export type Provider = 'github' | 'gitlab'
export type Tab = 'mine' | 'others' | 'closed'
export type Snapshot = { provider: Provider; issues: Issue[]; others: Issue[]; closed: Issue[]; fetchedAt: string; error?: string; herdrError?: string; othersError?: string; closedError?: string }

declare module 'claude-code' {
  interface PluginState {
    'gl-issues': { snapshot: Snapshot | null; collapsed: string[]; tab: Tab }
  }
}
