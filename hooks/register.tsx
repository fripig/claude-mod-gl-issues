import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Issue, SessionRef, Snapshot } from '../types'

const PANE = 'gl-issues'
const REFRESH_MS = 5 * 60 * 1000
// issue board 的狀態 label，依流程順序；換成自己 board 的 label。
// 已上線待檢驗給沒有測試站的專案用（測試站／正式站待檢驗合併成一個）
export const STATUSES = ['進行中', '檢驗中', '測試站待檢驗', '正式站待檢驗', '已上線待檢驗', '可處理', '討論中', '已完成']
const NO_STATUS = '（無狀態）'
// 狀態 label 用亮色區分；已完成刻意不上色、改淡色
export const STATUS_COLOR: Record<string, string> = {
  進行中: '#4ade80',
  檢驗中: '#facc15',
  測試站待檢驗: '#22d3ee',
  正式站待檢驗: '#c084fc',
  已上線待檢驗: '#60a5fa',
  可處理: '#fb923c',
  討論中: '#f472b6',
}

const snapshot = atom({ plugin: 'gl-issues', key: 'snapshot' } as const, null as Snapshot | null)
// 收合中的狀態分組；已完成預設收起
const collapsed = atom({ plugin: 'gl-issues', key: 'collapsed' } as const, ['已完成'] as string[])

export const toggle = (list: string[], status: string): string[] =>
  list.includes(status) ? list.filter(s => s !== status) : [...list, status]

type RawIssue = { iid: number; title: string; labels: string[]; web_url: string; updated_at: string }
export type AgentMentions = { pane: string; title: string; status: string; mentions: { iid: number; count: number }[] }

// 列出 herdr 裡的 Claude agent，從分頁標題、cwd（gl-<id>- worktree）與使用者自己打的 prompt
// 抽出 issue 編號；transcript 全文含注入的 memory／git log，雜訊太多所以不掃
const MATCH_SCRIPT = `export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"
snap=$(herdr api snapshot) || exit 1
jq -c '.result.snapshot as $s | $s.agents[] | select(.agent == "claude") | . + {tab_label: (.tab_id as $t | first($s.tabs[] | select(.tab_id == $t) | .label) // "")}' <<<"$snap" | while IFS= read -r a; do
  id=$(jq -r '.agent_session.value // empty' <<<"$a")
  slug=$(jq -r '.cwd // ""' <<<"$a" | sed 's/[^A-Za-z0-9]/-/g')
  f="$HOME/.claude/projects/$slug/$id.jsonl"
  {
    jq -r '.terminal_title_stripped // "", .tab_label, .foreground_cwd // ""' <<<"$a"
    if [ -n "$id" ] && [ -f "$f" ]; then
      grep -F '"type":"user"' "$f" | jq -r 'select(.type == "user" and (.message.content | type == "string")) | .message.content' 2>/dev/null | grep -v '^<'
    fi
  } | perl -nle 'print $1 while m{(?:/(?:work_items|issues)/|\\bgl-|#|(?i:issue|work item|票) ?#?)(\\d{2,4})\\b}g' | sort | uniq -c \\
    | jq -Rsc --argjson a "$a" '{pane: $a.pane_id, title: ($a.terminal_title_stripped // ""), status: ($a.agent_status // ""), mentions: [split("\\n")[] | select(length > 0) | capture(" *(?<c>[0-9]+) (?<n>[0-9]+)") | {iid: (.n | tonumber), count: (.c | tonumber)}]}'
done | jq -sc .`

export const toIssue = (raw: RawIssue): Issue => ({
  iid: raw.iid,
  title: raw.title,
  status: raw.labels.find(l => STATUSES.includes(l)) ?? NO_STATUS,
  url: raw.web_url,
  updatedAt: raw.updated_at,
  sessions: [],
})

export const attachSessions = (issues: Issue[], agents: AgentMentions[]): Issue[] =>
  issues.map(issue => ({
    ...issue,
    sessions: agents
      .flatMap((a): SessionRef[] => {
        const hit = a.mentions.find(m => m.iid === issue.iid)
        return hit ? [{ pane: a.pane, title: a.title, status: a.status, count: hit.count }] : []
      })
      .sort((x, y) => y.count - x.count),
  }))

const STATUS_MARK: Record<string, string> = { working: '◑', blocked: '!', done: '✓', idle: '·' }

export const groupByStatus = (issues: Issue[]): [string, Issue[]][] =>
  [...STATUSES, NO_STATUS]
    .map(s => [s, issues.filter(i => i.status === s)] as [string, Issue[]])
    .filter(([, list]) => list.length > 0)

export const summarize = (issues: Issue[]): string =>
  groupByStatus(issues)
    .filter(([s]) => s !== '已完成')
    .map(([s, list]) => `${s} ${list.length}`)
    .join(' · ')

async function focusSession($: EngineInterface, ref: SessionRef) {
  const res = await $.process.run(['herdr', 'agent', 'focus', ref.pane])
  if (res.exitCode !== 0) $.ui.toast(`herdr 切換失敗：${res.stderr.trim() || res.exitCode}`)
}

export const sessionName = (issue: Issue): string => {
  const name = `#${issue.iid} ${issue.title}`
  return name.length > 40 ? `${name.slice(0, 39)}…` : name
}

export const agentName = (issue: Issue): string => `gl-${issue.iid}`

const launching = new Set<number>()

// 開新 herdr 分頁跑 claude，session 名帶 #<iid>，下次刷新時分頁標題就會對回這張 issue
async function startSession($: EngineInterface, issue: Issue) {
  if (launching.has(issue.iid)) return
  launching.add(issue.iid)
  const name = sessionName(issue)
  try {
    const cwd = await $.session.cwd()
    const tab = await $.process.run(['herdr', 'tab', 'create', '--focus', '--cwd', cwd, '--label', name])
    if (tab.exitCode !== 0) throw new Error(tab.stderr.trim() || `exit ${tab.exitCode}`)
    const pane = (JSON.parse(tab.stdout) as { result: { root_pane: { pane_id: string } } }).result.root_pane.pane_id
    // herdr 的 agent 名稱只收小寫英數、-、_；顯示用的名稱交給 claude -n 與分頁 label
    const started = await $.process.run(
      ['herdr', 'agent', 'start', agentName(issue), '--kind', 'claude', '--pane', pane, '--', '-n', name],
      { timeoutMs: 60000 },
    )
    if (started.exitCode !== 0) throw new Error(started.stderr.trim() || started.stdout.trim() || `exit ${started.exitCode}`)
    await refresh($)
  } catch (err) {
    $.ui.toast(`開 session 失敗：${String(err)}`)
  } finally {
    launching.delete(issue.iid)
  }
}

async function refresh($: EngineInterface) {
  const fetchedAt = new Date(await $.clock.now()).toLocaleTimeString('zh-TW', { hour12: false })
  try {
    const res = await $.process.run(
      ['glab', 'issue', 'list', '--assignee=@me', '--per-page', '100', '--output', 'json'],
      { timeoutMs: 30000 },
    )
    if (res.exitCode !== 0) throw new Error(res.stderr.trim().split('\n')[0] || `exit ${res.exitCode}`)
    let agents: AgentMentions[] = []
    let herdrError: string | undefined
    try {
      const m = await $.process.run(['bash', '-c', MATCH_SCRIPT], { timeoutMs: 30000 })
      if (m.exitCode !== 0) throw new Error(m.stderr.trim().split('\n')[0] || `exit ${m.exitCode}`)
      agents = JSON.parse(m.stdout) as AgentMentions[]
    } catch (err) {
      herdrError = String(err)
    }
    const issues = attachSessions((JSON.parse(res.stdout) as RawIssue[]).map(toIssue), agents)
    await update($, snapshot, () => ({ issues, fetchedAt, herdrError }))
    $.ui.status(`GL: ${summarize(issues) || '無待辦'}`)
  } catch (err) {
    await update($, snapshot, prev => ({ issues: prev?.issues ?? [], fetchedAt, error: String(err) }))
    $.ui.status('GL: 讀取失敗')
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'gl-issues', description: '開啟並重新整理指派給我的 GitLab issue 面板' })
    void refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    void $.ui.open({ id: PANE, title: 'GitLab issues' })
    return next(e)
  })

  on('command.run', { command: 'gl-issues' }, async $ => {
    await $.ui.open({ id: PANE, title: 'GitLab issues' })
    await refresh($)
    return { text: 'GitLab issue 面板已開啟並重新整理。' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const closed = await read($, collapsed)
    const groups = snap ? groupByStatus(snap.issues) : []
    const allClosed = groups.length > 0 && groups.every(([s]) => closed.includes(s))

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Text dimColor>{snap ? `更新於 ${snap.fetchedAt}` : '讀取中…'}</Text>
          <Button onPress={() => void refresh($)}>重新整理</Button>
          {groups.length > 0 && (
            <Button
              key="toggle-all"
              onPress={() => void update($, collapsed, () => (allClosed ? [] : groups.map(([s]) => s)))}
            >
              {allClosed ? '全部展開' : '全部收合'}
            </Button>
          )}
        </Box>
        {snap?.error && <Text color="red">glab 失敗：{snap.error}</Text>}
        {snap?.herdrError && <Text dimColor>herdr 比對略過：{snap.herdrError}</Text>}
        {snap && snap.issues.length === 0 && !snap.error && <Text dimColor>沒有指派給你的 open issue。</Text>}
        {groups.map(([status, list]) => (
            <Box flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Button plain key={`group-${status}`} onPress={() => void update($, collapsed, c => toggle(c, status))}>
                  {closed.includes(status) ? '▸' : '▾'}
                </Button>
                <Text bold color={STATUS_COLOR[status]} dimColor={status === '已完成'}>
                  {status}（{list.length}）
                </Text>
              </Box>
              {!closed.includes(status) && list.map(i => (
                <Box flexDirection="column">
                  {i.sessions.length > 0 ? (
                    <Text wrap="truncate-end">
                      <Link href={i.url}>#{i.iid}</Link> {i.title}
                    </Text>
                  ) : (
                    <Box flexDirection="row" gap={1}>
                      <Button key={`start-${i.iid}`} onPress={() => void startSession($, i)}>
                        {`#${i.iid} ▶`}
                      </Button>
                      <Text wrap="truncate-end">
                        <Link href={i.url}>{i.title}</Link>
                      </Text>
                    </Box>
                  )}
                  {i.sessions.map(ref => (
                    <Button key={`${i.iid}-${ref.pane}`} onPress={() => void focusSession($, ref)}>
                      {`  ↪ ${STATUS_MARK[ref.status] ?? '·'} ${ref.title || ref.pane}`}
                    </Button>
                  ))}
                </Box>
              ))}
            </Box>
          ))}
      </Box>
    )
  })
}
