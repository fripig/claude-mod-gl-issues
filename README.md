# gl-issues

Claude Code mod：在側邊面板列出指派給自己的 GitLab／GitHub open issue，依 board 狀態 label 分組，並對到本機 [herdr](https://herdr.dev) 裡正在處理該 issue 的 Claude session，一鍵切換或開新 session。

```
更新於 14:32:05  [重新整理] [全部收合]

▾ 進行中（2）
[#12] 新增登入頁              ← 點票號：用瀏覽器開 issue 頁面
  ↪ ◑ Work item #12           ← 切到那個 herdr 分頁
[#15] [▶] 匯出報表 CSV        ← 沒有 session：點 ▶ 開新分頁跑 claude
▸ 已完成（3）
```

## 功能

- **狀態分組**：依 label `進行中`／`檢驗中`／`測試站待檢驗`／`正式站待檢驗`／`已上線待檢驗`／`可處理`／`討論中`／`已完成` 分組，各組亮色區分、可收合（`已完成` 預設收起）。
- **GitLab／GitHub 自動切換**：看 repo 的 `origin` remote，指到 `github.com` 就用 `gh`，其餘（含自架 GitLab）用 `glab`。兩邊共用同名狀態 label。
- **狀態列摘要**：`GL: 進行中 2 · 討論中 5`（GitHub repo 顯示 `GH:`）。
- **對應本機 session**：從 herdr 分頁標題／label、工作目錄（`gl-<id>-` worktree）與使用者自己輸入的 prompt 抽出 issue 編號（`#123`、`gl-123-`、issue 網址、`issue 123`），點 `↪` 用 `herdr agent focus` 切過去。
- **開 issue 頁面**：點票號 `#<id>` 用系統預設瀏覽器打開（macOS `open`，其他系統 `xdg-open`），不靠終端機的超連結支援。
- **開新 session**：沒對到 session 的 issue，點 `▶` 會開 herdr 分頁並以 `claude -n "#<id> <標題>"` 啟動，接著送出初始 prompt，請 Claude 用 `gh`／`glab` 讀 issue 內容與留言、摘要需求後停下等指示。
- 每 5 分鐘自動刷新，或 `/gl-issues` 手動開啟並刷新。

## 需求

- Claude Code 在目標專案的 repo 內啟動，並依 remote 準備對應 CLI：
  - GitLab：[`glab`](https://gitlab.com/gitlab-org/cli) 已登入（`glab issue list --assignee=@me`）
  - GitHub：[`gh`](https://cli.github.com) 已登入（`gh issue list --assignee @me`），repo 上建好同名狀態 label
- herdr、`jq`、`perl`（session 比對與切換；沒有 herdr 時只顯示 issue 清單）

狀態 label 名稱寫在 `hooks/register.tsx` 的 `STATUSES`／`STATUS_COLOR`，換成自己 board 的 label 即可。

## 安裝

```
/plugin install gl-issues --marketplace fripig/claude-mod-gl-issues
```

## 開發

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```
