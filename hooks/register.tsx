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

// 追蹤 label 是個人設定（userConfig.trackedLabels，存在使用者自己的 settings），不放共用的 CLAUDE.md
export const trackedLabels = (options: Readonly<Record<string, unknown>> | undefined): string[] => {
  const v = options?.trackedLabels
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []
  return list.filter((l): l is string => typeof l === 'string').map(l => l.trim()).filter(l => l.length > 0)
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
  await refresh($, 'rebuild')
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
export type AgentMentions = { pane: string; tab: string; cwd: string; title: string; status: string; app?: boolean; mentions: { iid: number; count: number }[] }

// agent 跑在哪個環境：從 Claude（腳本的父程序）沿父程序往上找，最近的是 herdr-core 就在 Herdr app 的 terminal 裡、
// 是 herdr 就在 herdr CLI（TUI）的 pane 裡。環境變數會被巢狀的 terminal 繼承，只在程序樹找不到時才參考；
// 都判斷不出來就照舊走 herdr CLI，不影響原本的行為。兩邊的 ID 互不相通，只比對、操作所在的那一邊
export type Platform = 'app' | 'herdr'
export const DETECT_SH = [
  'detect_platform() {',
  '  p=$PPID',
  '  while [ "${p:-0}" -gt 1 ]; do',
  '    c=$(ps -o comm= -p "$p" 2>/dev/null)',
  '    case "${c##*/}" in',
  '      herdr-core|hc) echo app; return ;;',
  '      herdr) echo herdr; return ;;',
  '    esac',
  '    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d " ")',
  '  done',
  '  if [ -n "${HC_TERMINAL_ID:-}" ]; then echo app; else echo herdr; fi',
  '}',
].join('\n')
export const PLATFORM_ARGV = ['bash', '-c', `${DETECT_SH}\ndetect_platform`]
export const parsePlatform = (stdout: string): Platform => (stdout.trim() === 'app' ? 'app' : 'herdr')

async function currentPlatform($: EngineInterface): Promise<Platform> {
  const res = await $.process.run(PLATFORM_ARGV, { timeoutMs: 10000 })
  return res.exitCode === 0 ? parsePlatform(res.stdout) : 'herdr'
}

// 列出目前前端裡的 Claude agent，從標題、分頁名稱、cwd（gl-<id>- worktree）與使用者自己打的 prompt
// 抽出 issue 編號；transcript 全文含注入的 memory／git log，雜訊太多所以不掃。
// app 的 .cwd 是 terminal 起始目錄，要看 foreground.cwd；hc 不回 session id，靠 foreground.pid 對 ~/.claude/sessions；
// 沒有 herdr.space label 的是背景 worker，視窗切不過去所以略過
export const MATCH_SCRIPT = `export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"
${DETECT_SH}
app=false
if [ "$(detect_platform)" = app ]; then
  app=true
  list=$(hc ls --json) || exit 1
  agents=$(jq -r '.terminals[] | select(.agent == "claude-code") | .address' <<<"$list" | while IFS= read -r t; do
    hc get "$t" --json | jq -c 'select(.labels["herdr.space"]) | (.foreground.cwd // .cwd // "") as $cwd | {pane: .address, tab: "", cwd: $cwd, fcwd: $cwd, title: (.labels.where // .title // ""), hint: (.title // ""), status: (.status.state // ""), pid: .foreground.pid}'
  done)
else
  snap=$(herdr api snapshot) || exit 1
  agents=$(jq -c '.result.snapshot as $s | $s.agents[] | select(.agent == "claude") | {pane: .pane_id, tab: (.tab_id // ""), cwd: (.cwd // ""), fcwd: (.foreground_cwd // ""), title: (.terminal_title_stripped // ""), hint: (.tab_id as $t | first($s.tabs[] | select(.tab_id == $t) | .label) // ""), status: (.agent_status // ""), session: .agent_session.value}' <<<"$snap")
fi
while IFS= read -r a; do
  [ -n "$a" ] || continue
  id=$(jq -r '.session // empty' <<<"$a")
  pid=$(jq -r '.pid // empty' <<<"$a")
  if [ -z "$id" ] && [ -n "$pid" ]; then
    id=$(jq -r '.sessionId // empty' "$HOME/.claude/sessions/$pid.json" 2>/dev/null)
  fi
  slug=$(jq -r '.cwd' <<<"$a" | sed 's/[^A-Za-z0-9]/-/g')
  f="$HOME/.claude/projects/$slug/$id.jsonl"
  {
    jq -r '.title, .hint, .fcwd' <<<"$a"
    if [ -n "$id" ] && [ -f "$f" ]; then
      grep -F '"type":"user"' "$f" | jq -r 'select(.type == "user" and (.message.content | type == "string")) | .message.content' 2>/dev/null | grep -v '^<'
    fi
  } | perl -nle 'print $1 while m{(?:/(?:work_items|issues)/|\\bgl-|#|(?i:issue|work item|票) ?#?)(\\d{1,5})\\b}g' | sort | uniq -c \\
    | jq -Rsc --argjson a "$a" --argjson app "$app" '{pane: $a.pane, tab: $a.tab, cwd: $a.cwd, title: $a.title, status: $a.status, mentions: [split("\\n")[] | select(length > 0) | capture(" *(?<c>[0-9]+) (?<n>[0-9]+)") | {iid: (.n | tonumber), count: (.c | tonumber)}]} + (if $app then {app: true} else {} end)'
done <<<"$agents" | jq -sc .`

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
        return hit ? [{ pane: a.pane, tab: a.tab, title: a.title, status: a.status, count: hit.count, ...(a.app ? { app: true } : {}) }] : []
      })
      .sort((x, y) => y.count - x.count),
  }))

// 追蹤中：沒指派給我、但帶追蹤 label 的 open issue
export const trackedOf = (all: RawIssue[], mine: RawIssue[], tracked: string[]): RawIssue[] => {
  const mineIids = new Set(mine.map(i => i.iid))
  return all.filter(i => !mineIids.has(i.iid) && i.labels.some(l => tracked.includes(l)))
}

// 「其他」分頁：整個專案的 open issue 扣掉「我的」分頁已列的
export const othersOf = (all: RawIssue[], mine: RawIssue[]): RawIssue[] => {
  const mineIids = new Set(mine.map(i => i.iid))
  return all.filter(i => !mineIids.has(i.iid))
}

const TABS: [Tab, string][] = [['mine', '我的'], ['others', '其他'], ['closed', '已關閉']]
const EMPTY_TEXT: Record<Tab, string> = {
  mine: '沒有指派給你或追蹤中的 open issue。',
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
// app 的 agent.focus 會自己切到那個 terminal 所在的 space 與分頁
export const focusArgvs = (ref: SessionRef): string[][] => ref.app
  ? [['herdr-app', 'do', 'agent.focus', '--terminal', ref.pane]]
  : [
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

// herdr 的 agent 名稱在活著的 agent 間必須唯一；同一張 issue 開第二個 session 時接 -2、-3…
export const freeAgentName = (issue: Issue, taken: readonly string[]): string => {
  const base = agentName(issue)
  if (!taken.includes(base)) return base
  let n = 2
  while (taken.includes(`${base}-${n}`)) n++
  return `${base}-${n}`
}

async function liveAgentNames($: EngineInterface): Promise<string[]> {
  const res = await $.process.run(['herdr', 'agent', 'list'])
  if (res.exitCode !== 0) return []
  const agents = (JSON.parse(res.stdout) as { result: { agents: { name?: string }[] } }).result.agents
  return agents.flatMap(a => (a.name ? [a.name] : []))
}

// 新 session 的第一句話：讓 Claude 自己用 CLI 讀 issue（含留言），摘要完先停下等指示
export const initialPrompt = (provider: Provider, issue: Issue): string => {
  const view = PROVIDERS[provider].view(issue.iid)
  return `請先用 \`${view}\` 讀取 issue #${issue.iid} 的內容與留言，摘要需求、驗收條件與待釐清的地方。摘要完先停下來等我指示，不要開始改程式碼。`
}

const launching = new Set<number>()

// herdr CLI 的 agent start 只在 pane 剛建好、還認不出 shell 時自己等；新分頁的 shell 啟動腳本還在跑時
// 會立刻回 agent_pane_busy 放棄，留下沒跑 claude 的空分頁。這種情況由 mod 自己等 shell 空下來再試
export const START_RETRY_MS = 500
export const START_MAX_TRIES = 60

export const herdrErrorCode = (out: string): string | undefined => {
  try {
    const code = (JSON.parse(out) as { error?: { code?: unknown } }).error?.code
    return typeof code === 'string' ? code : undefined
  } catch {
    return undefined
  }
}

async function startAgent($: EngineInterface, argv: string[]) {
  for (let attempt = 1; ; attempt++) {
    const res = await $.process.run(argv, { timeoutMs: 60000 })
    if (res.exitCode === 0) return
    const busy = [res.stderr, res.stdout].some(out => herdrErrorCode(out.trim()) === 'agent_pane_busy')
    if (!busy || attempt >= START_MAX_TRIES) throw new Error(res.stderr.trim() || res.stdout.trim() || `exit ${res.exitCode}`)
    await $.clock.sleep(START_RETRY_MS)
  }
}

// app 用一次 tab.new 同時開分頁、啟動 claude、送第一句話；整包 JSON 傳入，標題裡的引號、$ 不會被解讀
export const appTabArgv = (cwd: string, provider: Provider, issue: Issue): string[] => [
  'herdr-app', 'do', 'tab.new',
  JSON.stringify({ name: `#${issue.iid}`, folder: cwd, argv: ['claude', '-n', sessionName(issue)], task: initialPrompt(provider, issue) }),
]

async function startAppSession($: EngineInterface, provider: Provider, issue: Issue, cwd: string) {
  const res = await $.process.run(appTabArgv(cwd, provider, issue), { timeoutMs: 60000 })
  if (res.exitCode !== 0) throw new Error(res.stdout.trim() || res.stderr.trim() || `exit ${res.exitCode}`)
}

// 開新分頁跑 claude，session 名帶 #<iid>，下次刷新時分頁標題就會對回這張 issue
async function startSession($: EngineInterface, provider: Provider, issue: Issue) {
  if (launching.has(issue.iid)) return
  launching.add(issue.iid)
  const name = sessionName(issue)
  try {
    const cwd = await $.session.cwd()
    const platform = await currentPlatform($)
    if (platform === 'app') {
      await startAppSession($, provider, issue, cwd)
      await refresh($, 'rebuild')
      return
    }
    const tab = await $.process.run(['herdr', 'tab', 'create', '--focus', '--cwd', cwd, '--label', `#${issue.iid}`])
    if (tab.exitCode !== 0) throw new Error(tab.stderr.trim() || `exit ${tab.exitCode}`)
    const pane = (JSON.parse(tab.stdout) as { result: { root_pane: { pane_id: string } } }).result.root_pane.pane_id
    // herdr 的 agent 名稱只收小寫英數、-、_；顯示用的名稱交給 claude -n 與分頁 label
    await startAgent($, ['herdr', 'agent', 'start', freeAgentName(issue, await liveAgentNames($)), '--kind', 'claude', '--pane', pane, '--', '-n', name])
    // 初始 prompt 等 claude 就緒後才送進輸入框，不經 shell，標題裡的引號、$ 不會被解讀
    const prompted = await $.process.run(['herdr', 'agent', 'prompt', pane, initialPrompt(provider, issue)])
    if (prompted.exitCode !== 0) throw new Error(prompted.stderr.trim() || prompted.stdout.trim() || `exit ${prompted.exitCode}`)
    await refresh($, 'rebuild')
  } catch (err) {
    $.ui.toast(`開 session 失敗：${String(err)}`)
  } finally {
    launching.delete(issue.iid)
  }
}

// register 時由 options 設定；每次重載模組都重新讀
let tracked: string[] = []

// 抓回來的原始清單；同一專案（含 worktree）的所有 session 共用一份，存在 git common dir 底下
export type Lists = {
  fetchedAtMs: number
  mine: RawIssue[]
  all?: RawIssue[]
  allError?: string
  closed?: RawIssue[]
  closedError?: string
}
// fetchingAtMs：有 session 正在抓，其他 session 先等它寫回來，不重複抓
export type IssueCache = { provider: Provider; lists?: Lists; fetchingAtMs?: number }

const POLL_MS = 30 * 1000
const FETCH_LOCK_MS = 60 * 1000

// use：沿用快取；fetch：自己去抓；wait：別的 session 正在抓、目前也沒資料可顯示
export const cacheDecision = (cache: IssueCache | undefined, provider: Provider, now: number, force: boolean): 'use' | 'fetch' | 'wait' => {
  const same = cache?.provider === provider ? cache : undefined
  if (force) return 'fetch'
  if (same?.lists && now - same.lists.fetchedAtMs < REFRESH_MS) return 'use'
  if (same?.fetchingAtMs !== undefined && now - same.fetchingAtMs < FETCH_LOCK_MS) return same.lists ? 'use' : 'wait'
  return 'fetch'
}

async function cachePath($: EngineInterface): Promise<string | undefined> {
  try {
    const res = await $.process.run(['git', '-C', await $.session.cwd(), 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeoutMs: 5000 })
    return res.exitCode === 0 && res.stdout.trim() ? `${res.stdout.trim()}/gl-issues-cache.json` : undefined
  } catch {
    return undefined
  }
}

async function readCache($: EngineInterface, path: string | undefined): Promise<IssueCache | undefined> {
  if (!path) return undefined
  try {
    return JSON.parse(await $.fs.read(path)) as IssueCache
  } catch {
    return undefined
  }
}

// 快取寫不進去（不是 git repo、權限）就只是退回各自抓，不影響顯示
async function writeCache($: EngineInterface, path: string | undefined, cache: IssueCache) {
  if (!path) return
  try {
    await $.fs.write(path, JSON.stringify(cache))
  } catch {
    // 下次再試
  }
}

async function fetchLists($: EngineInterface, provider: Provider): Promise<Lists> {
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
  const mine = await list('mine')
  const all = await allRequest
  const closed = await closedRequest
  return {
    fetchedAtMs: await $.clock.now(),
    mine,
    ...(all.raws ? { all: all.raws } : { allError: all.error }),
    ...(closed.raws ? { closed: closed.raws } : { closedError: closed.error }),
  }
}

// 這個 session 上次畫面用的是哪一份清單、herdr 何時比對過
let shownFetchedAtMs: number | undefined
let matchedAtMs = 0
// 同一個 session 的 refresh 依序跑，不疊著抓
let queue: Promise<void> = Promise.resolve()

// poll：只讀共用快取，過期才抓；rebuild：重新比對 herdr session、重讀 CLAUDE.md；fetch：不管快取直接抓
type RefreshMode = 'poll' | 'rebuild' | 'fetch'

function refresh($: EngineInterface, mode: RefreshMode = 'poll'): Promise<void> {
  const run = queue.then(() => refreshOnce($, mode))
  queue = run.catch(() => undefined)
  return run
}

async function refreshOnce($: EngineInterface, mode: RefreshMode) {
  const provider = await currentProvider($)
  const p = PROVIDERS[provider]
  const path = await cachePath($)
  const now = await $.clock.now()
  const cache = await readCache($, path)
  const decision = cacheDecision(cache, provider, now, mode === 'fetch')
  if (decision === 'wait') return
  let lists = cache?.provider === provider ? cache.lists : undefined
  if (decision === 'fetch') {
    await writeCache($, path, { provider, ...(lists ? { lists } : {}), fetchingAtMs: now })
    try {
      lists = await fetchLists($, provider)
      await writeCache($, path, { provider, lists })
    } catch (err) {
      // 鎖要放掉，舊資料留著
      await writeCache($, path, { provider, ...(lists ? { lists } : {}) })
      const fetchedAt = new Date(now).toLocaleTimeString('zh-TW', { hour12: false })
      await update($, snapshot, prev => ({ provider, board: prev?.board ?? DEFAULT_BOARD, issues: prev?.issues ?? [], others: prev?.others ?? [], closed: prev?.closed ?? [], fetchedAt, error: String(err) }))
      $.ui.status(`${p.short}: 讀取失敗`)
      return
    }
  }
  if (!lists) return
  const changed = lists.fetchedAtMs !== shownFetchedAtMs
  if (mode === 'poll' && !changed && now - matchedAtMs < REFRESH_MS) return
  shownFetchedAtMs = lists.fetchedAtMs
  matchedAtMs = now
  await show($, provider, lists)
}

async function show($: EngineInterface, provider: Provider, lists: Lists) {
  const p = PROVIDERS[provider]
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
  const { mine, all, closed } = lists
  // 追蹤中的 issue 從整個專案的清單篩出；那份清單失敗時「我的」只剩指派給我的
  const extra = all ? trackedOf(all, mine, tracked) : []
  const issues = [...build(mine), ...build(extra).map(i => ({ ...i, tracked: true }))]
  await update($, snapshot, prev => ({
    provider,
    board,
    issues,
    others: all ? build(othersOf(all, [...mine, ...extra])) : prev?.others ?? [],
    closed: closed ? build(closed) : prev?.closed ?? [],
    fetchedAt: new Date(lists.fetchedAtMs).toLocaleTimeString('zh-TW', { hour12: false }),
    herdrError,
    ...(lists.allError ? { othersError: lists.allError } : {}),
    ...(lists.closedError ? { closedError: lists.closedError } : {}),
  }))
  $.ui.status(`${p.short}: ${summarize(issues, board) || '無待辦'}`)
}

export const register: Register = (on, options) => {
  tracked = trackedLabels(options)
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'gl-issues', description: '開啟並重新整理指派給我的 GitHub／GitLab issue 面板' })
    await $.command.register({ name: 'gl-issues-init', description: '在專案 CLAUDE.md 寫入預設的 issue 狀態 label 清單' })
    void refresh($)
    // 只讀共用快取，便宜；過期時由先輪到的 session 去抓
    $.clock.every(POLL_MS, () => void refresh($))
    void currentProvider($).then(provider => $.ui.open({ id: PANE, title: paneTitle(provider) }))
    return next(e)
  })

  on('command.run', { command: 'gl-issues-init' }, async $ => ({ text: await initBoard($) }))

  on('command.run', { command: 'gl-issues' }, async $ => {
    const provider = await currentProvider($)
    await $.ui.open({ id: PANE, title: paneTitle(provider) })
    await refresh($, 'fetch')
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
          <Button onPress={() => void refresh($, 'fetch')}>重新整理</Button>
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
                    <Button key={`start-${i.iid}`} onPress={() => void startSession($, snap.provider, i)}>
                      ▶
                    </Button>
                    {i.tracked && <Text dimColor>追蹤</Text>}
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
