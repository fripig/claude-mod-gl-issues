import { expect, test } from 'claude-code/testing'

import { attachSessions, groupByStatus, sessionName, summarize, toggle, toIssue } from './register'

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
    { pane: 'w1:p1', title: '順帶提到', status: 'idle', mentions: [{ iid: 118, count: 1 }] },
    { pane: 'w1:p2', title: 'Issue 整理', status: 'working', mentions: [{ iid: 118, count: 33 }, { iid: 86, count: 1 }] },
  ])
  expect(a?.sessions.map(s => s.pane)).toEqual(['w1:p2', 'w1:p1'])
  expect(b?.sessions).toEqual([])
})

test('/gl-issues 呼叫 glab 並更新面板與狀態列', async ($, on) => {
  const argvs: string[][] = []
  on('process.run', async (_$, e) => {
    argvs.push([...e.argv])
    const stdout = e.argv[0] === 'glab'
      ? JSON.stringify([raw(9, ['進行中'])])
      : JSON.stringify([{ pane: 'w1:p9', title: 'gl-9', status: 'idle', mentions: [{ iid: 9, count: 2 }] }])
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('clock.now', async () => ({ value: Date.UTC(2026, 9, 8) }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  const res = await $.command.run({ command: 'gl-issues', args: '' })
  expect(argvs[0]?.slice(0, 3)).toEqual(['glab', 'issue', 'list'])
  expect(argvs[1]?.[0]).toBe('bash')
  expect(JSON.stringify(res)).toContain('GitLab issue')
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
