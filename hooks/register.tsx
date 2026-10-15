import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Issue, Provider, SessionRef, Snapshot, Tab } from '../types'

const PANE = 'gl-issues'
const REFRESH_MS = 5 * 60 * 1000
const NO_STATUS = '（無狀態）'
// 沒指定顏色的狀態依序取用的亮色
const PALETTE = ['#4ade80', '#facc15', '#22d3ee', '#c084fc', '#60a5fa', '#fb923c', '#f472b6']

// 狀態 label 依流程排序；最後一項當作完成狀態：不上色、改淡色、預設收合
export const makeBoard = (entries: { name: string; color?: string }[]): Board => {
  const done = entries[entries.length - 1]?.name ?? ''
  const colors: Record<string, string> = {}
  entries.filter(e => e.name !== done).forEach((e, i) => {
    colors[e.name] = e.color ?? PALETTE[i % PALETTE.length]!
  })
  return { statuses: entries.map(e => e.name), colors, done }
}

// 專案 CLAUDE.md 沒寫「## Issue 狀態」時用這組；已上線待檢驗給沒有測試站的專案用
export const DEFAULT_BOARD = makeBoard(
  ['進行中', '檢驗中', '測試站待檢驗', '正式站待檢驗', '已上線待檢驗', '可處理', '討論中', '已完成'].map(name => ({ name })),
)

// 從 CLAUDE.md 的「## Issue 狀態」標題下讀清單項目，一項一個 label，可在後面接 #色碼；讀到下一個標題為止
export const parseBoard = (markdown: string): Board | undefined => {
  const lines = markdown.split('\n')
  const start = lines.findIndex(l => /^#{1,6}\s*issue\s*狀態\s*$/i.test(l.trim()))
  if (start < 0) return undefined
  const entries: { name: string; color?: string }[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break
    const m = /^\s*[-*+]\s+(.+?)(?:\s+(#[0-9a-f]{3}(?:[0-9a-f]{3})?))?\s*$/i.exec(line)
    if (m?.[1]) entries.push(m[2] ? { name: m[1], color: m[2] } : { name: m[1] })
  }
  return entries.length > 0 ? makeBoard(entries) : undefined
}

async function loadBoard($: EngineInterface, cwd: string): Promise<Board> {
  for (const path of [`${cwd}/CLAUDE.md`, `${cwd}/.claude/CLAUDE.md`]) {
    try {
      const board = parseBoard(await $.fs.read(path))
      if (board) return board
    } catch {
      // 沒有這個檔就看下一個
    }
  }
  return DEFAULT_BOARD
}

export const boardSection = (board: Board): string =>
  ['## Issue 狀態', '', ...board.statuses.map(s => `- ${s}`), ''].join('\n')

// 已有的 CLAUDE.md 後面空一行接上狀態段落；沒有就只有這一段
export const withBoardSection = (existing: string | undefined, board: Board): string =>
  existing?.trim() ? `${existing.replace(/\s*$/, '')}\n\n${boardSection(board)}` : boardSection(board)

// /gl-issues-init：把預設狀態清單寫進專案 CLAUDE.md，已經寫過就不動
async function initBoard($: EngineInterface): Promise<string> {
  const cwd = await $.session.cwd()
  for (const path of [`${cwd}/CLAUDE.md`, `${cwd}/.claude/CLAUDE.md`]) {
    const text = await $.fs.read(path).catch(() => undefined)
    if (text !== undefined && parseBoard(text)) return `${path} 已經有「## Issue 狀態」段落，沒有變更。`
  }
  const path = `${cwd}/CLAUDE.md`
  const existing = await $.fs.read(path).catch(() => undefined)
  await $.fs.write(path, withBoardSection(existing, DEFAULT_BOARD))
  await refresh($)
  return `已在 ${path} ${existing === undefined ? '建立' : '加上'}「## Issue 狀態」段落，改成自己 board 的 label 後按重新整理即可。`
}

const snapshot = atom({ plugin: 'gl-issues', key: 'snapshot' } as const, null as Snapshot | null)
// 收合中的狀態分組；還沒動過時（null）只收起完成狀態
const collapsed = atom({ plugin: 'gl-issues', key: 'collapsed' } as const, null as string[] | null)
// 面板分頁：指派給我的、同專案其他人的（含未指派）
const activeTab = atom({ plugin: 'gl-issues', key: 'tab' } as const, 'mine' as Tab)

export const toggle = (list: string[], status: string): string[] =>
  list.includes(status) ? list.filter(s => s !== status) : [...list, status]

type RawIssue = { iid: number; title: string; labels: string[]; web_url: string; updated_at: string }
type GitHubIssue = { number: number; title: string; labels: { name: string }[]; url: string; updatedAt: string }

export const fromGitHub = (gh: GitHubIssue): RawIssue => ({
  iid: gh.number,
  title: gh.title,
  labels: gh.labels.map(l => l.name),
  web_url: gh.url,
  updated_at: gh.updatedAt,
})

// 兩邊共用同名狀態 label，只差在用哪支 CLI 抓、JSON 長什麼樣
// list('mine') 指派給我的 open issue、'others' 整個專案的 open issue（再扣掉我的）、'closed' 指派給我已關閉的
export const PROVIDERS: Record<Provider, { name: string; short: string; cli: string; list: (tab: Tab) => string[]; parse: (stdout: string) => RawIssue[]; view: (iid: number) => string }> = {
  gitlab: {
    name: 'GitLab',
    short: 'GL',
    cli: 'glab',
    list: tab => ['glab', 'issue', 'list', ...(tab === 'others' ? [] : ['--assignee=@me']), ...(tab === 'closed' ? ['--closed'] : []), '--per-page', '100', '--output', 'json'],
    parse: stdout => JSON.parse(stdout) as RawIssue[],
    view: iid => `glab issue view ${iid} --comments`,
  },
  github: {
    name: 'GitHub',
    short: 'GH',
    cli: 'gh',
    list: tab => ['gh', 'issue', 'list', ...(tab === 'others' ? [] : ['--assignee', '@me']), '--state', tab === 'closed' ? 'closed' : 'open', '--limit', '100', '--json', 'number,title,labels,url,updatedAt'],
    parse: stdout => (JSON.parse(stdout) as GitHubIssue[]).map(fromGitHub),
    // gh issue view --comments 會查已停用的 Projects (classic) 而失敗，改用 --json
    view: iid => `gh issue view ${iid} --json title,body,labels,comments`,
  },
}

// origin 指到 github.com 就用 gh，其餘（含自架 GitLab）用 glab
export const detectProvider = (remoteUrl: string): Provider => (/github\.com[:/]/i.test(remoteUrl) ? 'github' : 'gitlab')

async function currentProvider($: EngineInterface): Promise<Provider> {
  try {
    const res = await $.process.run(['git', '-C', await $.session.cwd(), 'remote', 'get-url', 'origin'], { timeoutMs: 5000 })
    return detectProvider(res.exitCode === 0 ? res.stdout.trim() : '')
  } catch {
    return 'gitlab'
  }
}

const paneTitle = (provider: Provider): string => `${PROVIDERS[provider].name} issues`
export type AgentMentions = { pane: string; tab: string; cwd: string; title: string; status: string; mentions: { iid: number; count: number }[] }

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
  } | perl -nle 'print $1 while m{(?:/(?:work_items|issues)/|\\bgl-|#|(?i:issue|work item|票) ?#?)(\\d{1,5})\\b}g' | sort | uniq -c \\
    | jq -Rsc --argjson a "$a" '{pane: $a.pane_id, tab: ($a.tab_id // ""), cwd: ($a.cwd // ""), title: ($a.terminal_title_stripped // ""), status: ($a.agent_status // ""), mentions: [split("\\n")[] | select(length > 0) | capture(" *(?<c>[0-9]+) (?<n>[0-9]+)") | {iid: (.n | tonumber), count: (.c | tonumber)}]}'
done | jq -sc .`

export const toIssue = (raw: RawIssue, board: Board = DEFAULT_BOARD): Issue => ({
  iid: raw.iid,
  title: raw.title,
  status: raw.labels.find(l => board.statuses.includes(l)) ?? NO_STATUS,
  url: raw.web_url,
  updatedAt: raw.updated_at,
  sessions: [],
})

// 票號只在同一個 GitLab 專案內有意義，只比對同一專案目錄（含其下 worktree）的 session
export const sameProject = (agentCwd: string, sessionCwd: string): boolean =>
  agentCwd === sessionCwd || agentCwd.startsWith(`${sessionCwd}/`) || sessionCwd.startsWith(`${agentCwd}/`)

export const attachSessions = (issues: Issue[], agents: AgentMentions[]): Issue[] =>
  issues.map(issue => ({
    ...issue,
    sessions: agents
      .flatMap((a): SessionRef[] => {
        const hit = a.mentions.find(m => m.iid === issue.iid)
        return hit ? [{ pane: a.pane, tab: a.tab, title: a.title, status: a.status, count: hit.count }] : []
      })
      .sort((x, y) => y.count - x.count),
  }))

// 「其他」分頁：整個專案的 open issue 扣掉指派給我的
export const othersOf = (all: RawIssue[], mine: RawIssue[]): RawIssue[] => {
  const mineIids = new Set(mine.map(i => i.iid))
  return all.filter(i => !mineIids.has(i.iid))
}

const TABS: [Tab, string][] = [['mine', '我的'], ['others', '其他'], ['closed', '已關閉']]
const EMPTY_TEXT: Record<Tab, string> = {
  mine: '沒有指派給你的 open issue。',
  others: '沒有其他人的 open issue。',
  closed: '沒有指派給你的已關閉 issue。',
}
const CLOSED_GROUP = '已關閉'

// 已關閉的 issue 狀態 label 多半停在已完成，不分組，新的排前面
export const groupsFor = (tab: Tab, issues: Issue[], board: Board = DEFAULT_BOARD): [string, Issue[]][] =>
  tab !== 'closed'
    ? groupByStatus(issues, board)
    : issues.length > 0 ? [[CLOSED_GROUP, [...issues].sort((x, y) => y.iid - x.iid)]] : []

const STATUS_MARK: Record<string, string> = { working: '◑', blocked: '!', done: '✓', idle: '·' }

export const groupByStatus = (issues: Issue[], board: Board = DEFAULT_BOARD): [string, Issue[]][] =>
  [...board.statuses, NO_STATUS]
    .map(s => [s, issues.filter(i => i.status === s).sort((x, y) => x.iid - y.iid)] as [string, Issue[]])
    .filter(([, list]) => list.length > 0)

export const summarize = (issues: Issue[], board: Board = DEFAULT_BOARD): string =>
  groupByStatus(issues, board)
    .filter(([s]) => s !== board.done)
    .map(([s, list]) => `${s} ${list.length}`)
    .join(' · ')

// 終端機的 OSC 8 連結要看終端機（與 herdr）支不支援、常要按 Cmd；票號改用按鈕直接叫系統開瀏覽器
export const OPEN_URL_ARGV = (url: string): string[] =>
  ['bash', '-c', 'if command -v open >/dev/null; then open "$1"; else xdg-open "$1"; fi', '_', url]

async function openIssue($: EngineInterface, issue: Issue) {
  try {
    const res = await $.process.run(OPEN_URL_ARGV(issue.url), { timeoutMs: 10000 })
    if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `exit ${res.exitCode}`)
  } catch (err) {
    $.ui.toast(`開啟 issue 頁面失敗：${String(err)}`)
  }
}

// herdr server 0.9.0 的 agent focus 只改內部焦點、畫面不會切（0.9.3 已修），先 tab focus 切到那個分頁，
// 再 agent focus 讓分頁裡的對應 pane 拿到焦點（分頁有分割時才有差）
export const focusArgvs = (ref: SessionRef): string[][] => [
  ...(ref.tab ? [['herdr', 'tab', 'focus', ref.tab]] : []),
  ['herdr', 'agent', 'focus', ref.pane],
]

// 按鈕的 handler 是 void 呼叫，process.run reject（啟動不了、逾時）不接住就會無聲失敗
async function focusSession($: EngineInterface, ref: SessionRef) {
  try {
    for (const argv of focusArgvs(ref)) {
      const res = await $.process.run(argv, { timeoutMs: 10000 })
      if (res.exitCode !== 0) throw new Error(res.stderr.trim() || res.stdout.trim() || `exit ${res.exitCode}`)
    }
  } catch (err) {
    $.ui.toast(`herdr 切換到 ${ref.pane} 失敗：${String(err)}`)
  }
}

export const sessionName = (issue: Issue): string => {
  const name = `#${issue.iid} ${issue.title}`
  return name.length > 40 ? `${name.slice(0, 39)}…` : name
}

export const agentName = (issue: Issue): string => `gl-${issue.iid}`

// 新 session 的第一句話：讓 Claude 自己用 CLI 讀 issue（含留言），摘要完先停下等指示
export const initialPrompt = (provider: Provider, issue: Issue): string => {
  const view = PROVIDERS[provider].view(issue.iid)
  return `請先用 \`${view}\` 讀取 issue #${issue.iid} 的內容與留言，摘要需求、驗收條件與待釐清的地方。摘要完先停下來等我指示，不要開始改程式碼。`
}

const launching = new Set<number>()

// 開新 herdr 分頁跑 claude，session 名帶 #<iid>，下次刷新時分頁標題就會對回這張 issue
async function startSession($: EngineInterface, provider: Provider, issue: Issue) {
  if (launching.has(issue.iid)) return
  launching.add(issue.iid)
  const name = sessionName(issue)
  try {
    const cwd = await $.session.cwd()
    const tab = await $.process.run(['herdr', 'tab', 'create', '--focus', '--cwd', cwd, '--label', `#${issue.iid}`])
    if (tab.exitCode !== 0) throw new Error(tab.stderr.trim() || `exit ${tab.exitCode}`)
    const pane = (JSON.parse(tab.stdout) as { result: { root_pane: { pane_id: string } } }).result.root_pane.pane_id
    // herdr 的 agent 名稱只收小寫英數、-、_；顯示用的名稱交給 claude -n 與分頁 label
    const started = await $.process.run(
      ['herdr', 'agent', 'start', agentName(issue), '--kind', 'claude', '--pane', pane, '--', '-n', name],
      { timeoutMs: 60000 },
    )
    if (started.exitCode !== 0) throw new Error(started.stderr.trim() || started.stdout.trim() || `exit ${started.exitCode}`)
    // 初始 prompt 等 claude 就緒後才送進輸入框，不經 shell，標題裡的引號、$ 不會被解讀
    const prompted = await $.process.run(['herdr', 'agent', 'prompt', pane, initialPrompt(provider, issue)])
    if (prompted.exitCode !== 0) throw new Error(prompted.stderr.trim() || prompted.stdout.trim() || `exit ${prompted.exitCode}`)
    await refresh($)
  } catch (err) {
    $.ui.toast(`開 session 失敗：${String(err)}`)
  } finally {
    launching.delete(issue.iid)
  }
}

async function refresh($: EngineInterface) {
  const fetchedAt = new Date(await $.clock.now()).toLocaleTimeString('zh-TW', { hour12: false })
  const provider = await currentProvider($)
  const p = PROVIDERS[provider]
  const list = async (tab: Tab): Promise<RawIssue[]> => {
    const res = await $.process.run(p.list(tab), { timeoutMs: 30000 })
    if (res.exitCode !== 0) throw new Error(res.stderr.trim().split('\n')[0] || `exit ${res.exitCode}`)
    return p.parse(res.stdout)
  }
  // 其他、已關閉分頁的清單失敗不影響「我的」分頁
  const settle = (tab: Tab) => list(tab).then(
    raws => ({ raws, error: undefined as string | undefined }),
    (err: unknown) => ({ raws: undefined as RawIssue[] | undefined, error: String(err) }),
  )
  const allRequest = settle('others')
  const closedRequest = settle('closed')
  try {
    const mine = await list('mine')
    const all = await allRequest
    const closed = await closedRequest
    let agents: AgentMentions[] = []
    let herdrError: string | undefined
    try {
      const m = await $.process.run(['bash', '-c', MATCH_SCRIPT], { timeoutMs: 30000 })
      if (m.exitCode !== 0) throw new Error(m.stderr.trim().split('\n')[0] || `exit ${m.exitCode}`)
      agents = JSON.parse(m.stdout) as AgentMentions[]
    } catch (err) {
      herdrError = String(err)
    }
    const cwd = await $.session.cwd()
    const local = agents.filter(a => sameProject(a.cwd, cwd))
    const board = await loadBoard($, cwd)
    const build = (raws: RawIssue[]) => attachSessions(raws.map(r => toIssue(r, board)), local)
    const issues = build(mine)
    await update($, snapshot, prev => ({
      provider,
      board,
      issues,
      others: all.raws ? build(othersOf(all.raws, mine)) : prev?.others ?? [],
      closed: closed.raws ? build(closed.raws) : prev?.closed ?? [],
      fetchedAt,
      herdrError,
      othersError: all.error,
      closedError: closed.error,
    }))
    $.ui.status(`${p.short}: ${summarize(issues, board) || '無待辦'}`)
  } catch (err) {
    await update($, snapshot, prev => ({ provider, board: prev?.board ?? DEFAULT_BOARD, issues: prev?.issues ?? [], others: prev?.others ?? [], closed: prev?.closed ?? [], fetchedAt, error: String(err) }))
    $.ui.status(`${p.short}: 讀取失敗`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'gl-issues', description: '開啟並重新整理指派給我的 GitHub／GitLab issue 面板' })
    await $.command.register({ name: 'gl-issues-init', description: '在專案 CLAUDE.md 寫入預設的 issue 狀態 label 清單' })
    void refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    void currentProvider($).then(provider => $.ui.open({ id: PANE, title: paneTitle(provider) }))
    return next(e)
  })

  on('command.run', { command: 'gl-issues-init' }, async $ => ({ text: await initBoard($) }))

  on('command.run', { command: 'gl-issues' }, async $ => {
    const provider = await currentProvider($)
    await $.ui.open({ id: PANE, title: paneTitle(provider) })
    await refresh($)
    return { text: `${PROVIDERS[provider].name} issue 面板已開啟並重新整理。` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const board = snap?.board ?? DEFAULT_BOARD
    const closed = (await read($, collapsed)) ?? [board.done]
    const current = await read($, activeTab)
    const listOf = (s: Snapshot, t: Tab): Issue[] => (t === 'mine' ? s.issues : t === 'others' ? s.others : s.closed)
    const shown = snap ? listOf(snap, current) : []
    const groups = groupsFor(current, shown, board)
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
        <Box flexDirection="row" gap={1}>
          {TABS.map(([id, label]) => (
            <Button
              key={`tab-${id}`}
              {...(current === id ? { variant: 'primary' as const } : {})}
              dimColor={current !== id}
              onPress={() => void update($, activeTab, () => id)}
            >
              {`${label}（${snap ? listOf(snap, id).length : '…'}）`}
            </Button>
          ))}
        </Box>
        {snap?.error && <Text color="red">{PROVIDERS[snap.provider].cli} 失敗：{snap.error}</Text>}
        {snap && (current === 'others' ? snap.othersError : current === 'closed' ? snap.closedError : undefined) && (
          <Text color="red">{PROVIDERS[snap.provider].cli} 失敗：{current === 'others' ? snap.othersError : snap.closedError}</Text>
        )}
        {snap?.herdrError && <Text dimColor>herdr 比對略過：{snap.herdrError}</Text>}
        {snap && shown.length === 0 && !snap.error && (
          <Text dimColor>{EMPTY_TEXT[current]}</Text>
        )}
        {groups.map(([status, list]) => (
            <Box flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Button plain key={`group-${status}`} onPress={() => void update($, collapsed, c => toggle(c ?? [board.done], status))}>
                  {closed.includes(status) ? '▸' : '▾'}
                </Button>
                <Text bold color={board.colors[status]} dimColor={status === board.done}>
                  {status}（{list.length}）
                </Text>
              </Box>
              {!closed.includes(status) && list.map(i => (
                <Box flexDirection="column">
                  <Box flexDirection="row" gap={1}>
                    <Button key={`open-${i.iid}`} onPress={() => void openIssue($, i)}>
                      {`#${i.iid}`}
                    </Button>
                    {i.sessions.length === 0 && (
                      <Button key={`start-${i.iid}`} onPress={() => void startSession($, snap.provider, i)}>
                        ▶
                      </Button>
                    )}
                    <Text wrap="truncate-end">
                      <Link href={i.url}>{i.title}</Link>
                    </Text>
                  </Box>
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
