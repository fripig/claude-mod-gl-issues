import { expect, test } from 'claude-code/testing'

import { OPEN_URL_ARGV, agentName, attachSessions, detectProvider, fromGitHub, initialPrompt, sameProject, groupByStatus, sessionName, summarize, toggle, toIssue } from './register'

const raw = (iid: number, labels: string[]) => ({ iid, title: `t${iid}`, labels, web_url: `u${iid}`, updated_at: '' })

test('依 board 狀態 label 分組，排序照流程、無狀態排最後', async () => {
  const issues = [raw(1, ['討論中']), raw(2, ['bug', '進行中']), raw(3, []), raw(4, ['進行中'])].map(toIssue)
  expect(groupByStatus(issues).map(([s, l]) => [s, l.map(i => i.iid)])).toEqual([
    ['進行中', [2, 4]],
    ['討論中', [1]],
    ['（無狀態）', [3]],
  ])
})

test('狀態列摘要略過已完成', async () => {
  const issues = [raw(1, ['已完成']), raw(2, ['檢驗中'])].map(toIssue)
  expect(summarize(issues)).toBe('檢驗中 1')
})

test('issue 對上提到它的 herdr session，依提及次數排序', async () => {
  const [a, b] = attachSessions([raw(118, []), raw(5, [])].map(toIssue), [
    { pane: 'w1:p1', cwd: '/r', title: '順帶提到', status: 'idle', mentions: [{ iid: 118, count: 1 }] },
    { pane: 'w1:p2', cwd: '/r', title: 'Issue 整理', status: 'working', mentions: [{ iid: 118, count: 33 }, { iid: 86, count: 1 }] },
  ])
  expect(a?.sessions.map(s => s.pane)).toEqual(['w1:p2', 'w1:p1'])
  expect(b?.sessions).toEqual([])
})

const runCommand = async ($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1], remote: string, issuesJson: string) => {
  const argvs: string[][] = []
  const statuses: string[] = []
  on('process.run', async (_$, e) => {
    argvs.push([...e.argv])
    const stdout = e.argv[0] === 'git'
      ? `${remote}\n`
      : e.argv[0] === 'bash'
        ? JSON.stringify([{ pane: 'w1:p9', cwd: '/r', title: 'gl-9', status: 'idle', mentions: [{ iid: 9, count: 2 }] }])
        : issuesJson
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('session.cwd', async () => ({ value: '/r' }) as never)
  on('clock.now', async () => ({ value: Date.UTC(2026, 9, 8) }) as never)
  on('ui.status', async (_$, e) => {
    statuses.push(String((e as { text?: unknown }).text ?? JSON.stringify(e)))
    return { value: undefined } as never
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  const res = await $.command.run({ command: 'gl-issues', args: '' })
  return { argvs, statuses, res }
}

test('/gl-issues 在 GitLab repo 呼叫 glab 並更新面板與狀態列', async ($, on) => {
  const { argvs, statuses, res } = await runCommand($, on, 'git@gitlab.example.com:team/app.git', JSON.stringify([raw(9, ['進行中'])]))
  const issueCall = argvs.find(a => a[0] !== 'git' && a[0] !== 'bash')
  expect(issueCall?.slice(0, 3)).toEqual(['glab', 'issue', 'list'])
  expect(argvs.some(a => a[0] === 'bash')).toBe(true)
  expect(statuses.join('|')).toContain('GL: 進行中 1')
  expect(JSON.stringify(res)).toContain('GitLab issue')
})

test('/gl-issues 在 GitHub repo 改用 gh', async ($, on) => {
  const gh = [{ number: 9, title: 't9', labels: [{ name: '檢驗中' }], url: 'https://github.com/o/r/issues/9', updatedAt: '' }]
  const { argvs, statuses, res } = await runCommand($, on, 'https://github.com/o/r.git', JSON.stringify(gh))
  const issueCall = argvs.find(a => a[0] !== 'git' && a[0] !== 'bash')
  expect(issueCall?.slice(0, 3)).toEqual(['gh', 'issue', 'list'])
  expect(statuses.join('|')).toContain('GH: 檢驗中 1')
  expect(JSON.stringify(res)).toContain('GitHub issue')
})

test('依 origin URL 判斷 GitHub／GitLab', async () => {
  expect(detectProvider('https://github.com/fripig/x.git')).toBe('github')
  expect(detectProvider('git@github.com:fripig/x.git')).toBe('github')
  expect(detectProvider('git@gitlab.com:fripig/x.git')).toBe('gitlab')
  expect(detectProvider('https://git.company.tw/team/x.git')).toBe('gitlab')
  expect(detectProvider('')).toBe('gitlab')
})

test('GitHub issue 轉成共用格式，label 照樣分組', async () => {
  const issue = toIssue(fromGitHub({ number: 3, title: 'x', labels: [{ name: 'bug' }, { name: '可處理' }], url: 'u', updatedAt: 'd' }))
  expect(issue).toEqual({ iid: 3, title: 'x', status: '可處理', url: 'u', updatedAt: 'd', sessions: [] })
})

test('session 名以 #<iid> 開頭（讓刷新時對得回 issue），過長截斷', async () => {
  expect(sessionName(toIssue(raw(42, [])))).toBe('#42 t42')
  const long = sessionName({ ...toIssue(raw(7, [])), title: '很'.repeat(60) })
  expect(long.startsWith('#7 ')).toBe(true)
  expect(long.length).toBe(40)
})

test('收合切換：有就移除、沒有就加入', async () => {
  expect(toggle(['已完成'], '已完成')).toEqual([])
  expect(toggle(['已完成'], '進行中')).toEqual(['已完成', '進行中'])
})

test('已上線待檢驗是獨立狀態，排在正式站待檢驗之後', async () => {
  const issues = [raw(1, ['可處理']), raw(2, ['已上線待檢驗']), raw(3, ['正式站待檢驗'])].map(toIssue)
  expect(groupByStatus(issues).map(([s]) => s)).toEqual(['正式站待檢驗', '已上線待檢驗', '可處理'])
})

test('herdr agent 名稱符合 herdr 規則（小寫英數、-、_，1-32 字）', async () => {
  const name = agentName({ ...toIssue(raw(1234, [])), title: '#中文 標題 With Spaces' })
  expect(name).toBe('gl-1234')
  expect(/^[a-z][a-z0-9_-]{0,31}$/.test(name)).toBe(true)
})

test('只比對同一專案目錄（含其下 worktree）的 session', async () => {
  expect(sameProject('/git/app', '/git/app')).toBe(true)
  expect(sameProject('/git/app/.claude/worktrees/x', '/git/app')).toBe(true)
  expect(sameProject('/git/app', '/git/app/sub')).toBe(true)
  expect(sameProject('/git/app-bot', '/git/app')).toBe(false)
})

test('新 session 的初始 prompt 依來源用對的 CLI 讀 issue，並帶 #<iid> 方便對回', async () => {
  const issue = toIssue(raw(12, []))
  expect(initialPrompt('github', issue)).toContain('`gh issue view 12 --json title,body,labels,comments`')
  expect(initialPrompt('gitlab', issue)).toContain('`glab issue view 12 --comments`')
  expect(initialPrompt('github', issue)).toContain('#12')
})

test('票號按鈕用系統預設瀏覽器開 issue 頁面，網址以參數傳入不經 shell 拼接', async () => {
  const argv = OPEN_URL_ARGV('https://github.com/o/r/issues/1?a=$(x)')
  expect(argv[0]).toBe('bash')
  expect(argv[argv.length - 1]).toBe('https://github.com/o/r/issues/1?a=$(x)')
  expect(argv[2]).not.toContain('github.com')
})

test('同一狀態內依票號由小到大排列', async () => {
  const issues = [raw(30, ['進行中']), raw(4, ['進行中']), raw(118, ['進行中']), raw(12, ['進行中'])].map(toIssue)
  expect(groupByStatus(issues)[0]?.[1].map(i => i.iid)).toEqual([4, 12, 30, 118])
})

test('面板上按 ↪ 會用 herdr agent focus 切到那個 session', async ($, on) => {
  const { argvs } = await runCommand($, on, 'https://github.com/o/r.git',
    JSON.stringify([{ number: 9, title: 't9', labels: [{ name: '進行中' }], url: 'u', updatedAt: '' }]))
  for (const surface of ['terminal', 'desktop'] as const) {
    argvs.length = 0
    const ui = await $.ui.mount({ plugin: 'gl-issues', surface, component: 'Pane', requestId: 'gl-issues', props: { title: 'GitHub issues' } as never })
    await ui.press({ key: '9-w1:p9' })
    expect(argvs).toContainEqual(['herdr', 'agent', 'focus', 'w1:p9'])
    await ui.unmount()
  }
})

test('herdr focus 啟動不了時跳 toast，不再無聲失敗', async ($, on) => {
  const toasts: string[] = []
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'herdr') throw new Error('spawn herdr ENOENT')
    const stdout = e.argv[0] === 'git'
      ? 'https://github.com/o/r.git\n'
      : e.argv[0] === 'bash'
        ? JSON.stringify([{ pane: 'w1:p9', cwd: '/r', title: 'gl-9', status: 'idle', mentions: [{ iid: 9, count: 2 }] }])
        : JSON.stringify([{ number: 9, title: 't9', labels: [{ name: '進行中' }], url: 'u', updatedAt: '' }])
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('session.cwd', async () => ({ value: '/r' }) as never)
  on('clock.now', async () => ({ value: Date.UTC(2026, 9, 8) }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', async (_$, e) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined } as never
  })
  await $.command.run({ command: 'gl-issues', args: '' })
  const ui = await $.ui.mount({ plugin: 'gl-issues', surface: 'terminal', component: 'Pane', requestId: 'gl-issues', props: { title: 'GitHub issues' } as never })
  await ui.press({ key: '9-w1:p9' })
  expect(toasts.join('|')).toContain('herdr 切換到 w1:p9 失敗')
})
