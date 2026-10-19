export type SessionRef = { pane: string; tab: string; title: string; status: string; count: number }
// tracked：沒指派給我、因帶追蹤 label 併進「我的」分頁
export type Issue = { iid: number; title: string; status: string; url: string; updatedAt: string; sessions: SessionRef[]; tracked?: boolean }
export type Provider = 'github' | 'gitlab'
export type Tab = 'mine' | 'others' | 'closed'
export type Board = { statuses: string[]; colors: Record<string, string>; done: string }
export type Snapshot = { provider: Provider; board: Board; issues: Issue[]; others: Issue[]; closed: Issue[]; fetchedAt: string; error?: string; herdrError?: string; othersError?: string; closedError?: string }

declare module 'claude-code' {
  interface PluginState {
    'gl-issues': { snapshot: Snapshot | null; collapsed: string[] | null; tab: Tab }
  }
}
