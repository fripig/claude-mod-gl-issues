# gl-issues

Claude Code mod：在側邊面板列出指派給自己的 GitLab／GitHub open issue，依 board 狀態 label 分組，並對到本機 [herdr](https://herdr.dev) 裡正在處理該 issue 的 Claude session，一鍵切換或開新 session。

```
更新於 14:32:05  [重新整理] [全部收合]

▾ 進行中（2）
[#12] [▶] 新增登入頁          ← 點票號：用瀏覽器開 issue 頁面
  ↪ ◑ Work item #12           ← 切到那個 herdr 分頁
[#15] [▶] 匯出報表 CSV        ← 點 ▶ 開新分頁跑 claude（已有 session 也能再開）
▸ 已完成（3）
```

## 功能

- **追蹤 label**：帶 `CLAUDE.md` 所列追蹤 label 的 issue 即使指派給別人也併進「我的」分頁。
- **狀態分組**：依專案 `CLAUDE.md` 列的狀態 label 分組（沒寫就用 `進行中`／`檢驗中`／`測試站待檢驗`／`正式站待檢驗`／`已上線待檢驗`／`可處理`／`討論中`／`已完成`），各組亮色區分、可收合（最後一項預設收起）。
- **GitLab／GitHub 自動切換**：看 repo 的 `origin` remote，指到 `github.com` 就用 `gh`，其餘（含自架 GitLab）用 `glab`。兩邊共用同名狀態 label。
- **狀態列摘要**：`GL: 進行中 2 · 討論中 5`（GitHub repo 顯示 `GH:`）。
- **對應本機 session**：從 herdr 分頁標題／label、工作目錄（`gl-<id>-` worktree）與使用者自己輸入的 prompt 抽出 issue 編號（`#123`、`gl-123-`、issue 網址、`issue 123`），點 `↪` 用 `herdr tab focus` 切到那個分頁、再 `herdr agent focus` 那個 pane。
- **開 issue 頁面**：點票號 `#<id>` 用系統預設瀏覽器打開（macOS `open`，其他系統 `xdg-open`），不靠終端機的超連結支援。
- **開新 session**：每張 issue 都有 `▶`（已有 session 的也能再開一個，herdr agent 名稱依序用 `gl-<id>`、`gl-<id>-2`…避開重複），點了會開 herdr 分頁並以 `claude -n "#<id> <標題>"` 啟動，接著送出初始 prompt，請 Claude 用 `gh`／`glab` 讀 issue 內容與留言、摘要需求後停下等指示。
- 每 5 分鐘自動刷新，或 `/gl-issues` 手動開啟並刷新。

## 需求

- Claude Code 在目標專案的 repo 內啟動，並依 remote 準備對應 CLI：
  - GitLab：[`glab`](https://gitlab.com/gitlab-org/cli) 已登入（`glab issue list --assignee=@me`）
  - GitHub：[`gh`](https://cli.github.com) 已登入（`gh issue list --assignee @me`），repo 上建好同名狀態 label
- herdr、`jq`、`perl`（session 比對與切換；沒有 herdr 時只顯示 issue 清單）

### 自訂狀態 label

在專案根目錄的 `CLAUDE.md`（或 `.claude/CLAUDE.md`）加一段 `## Issue 狀態` 清單（執行 `/gl-issues-init` 會寫入預設清單，已經有就不動），順序就是面板的排序，最後一項當完成狀態（淡色、預設收合、不算進狀態列）。顏色可在後面接色碼，沒寫就依序自動配色。每次重新整理都會重讀。

```markdown
## Issue 狀態

- 進行中 #4ade80
- 檢驗中
- 可處理
- 討論中
- 已完成
```

### 追蹤 label

指派給別人、但自己還要盯的卡，可在同一份 `CLAUDE.md` 加一段 `## Issue 追蹤` 清單，列出用來標記追蹤的 label。帶這些 label 的 open issue 會併進「我的」分頁（照狀態分組，標題前標「追蹤」），不再出現在「其他」分頁。追蹤卡從整個專案的 issue 清單篩出，那份清單讀取失敗時「我的」只列指派給自己的。

```markdown
## Issue 追蹤

- fripig
```

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
