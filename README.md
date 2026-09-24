# neko-browser

Dedicated browser MCP server for [neko-gundan](https://github.com/aliksir/neko-gundan) agents. Headed Playwright with persistent profile, fully isolated from daily-use Chrome.

## Features

- **Persistent profile**: Sessions survive restarts (cookies, localStorage, login state preserved)
- **Headed mode**: GUI visible by default for debugging and human oversight
- **40 MCP tools**: Full browser automation toolkit with Power Platform UI support
- **PII masking**: Sensitive data (credit cards, SSNs, emails) auto-masked in responses
- **Process isolation**: Runs its own Chromium instance with dedicated profile directory
- **Custom favicon**: Shigoto-neko icon injected for easy identification

## Tools

| Tool | Description |
|------|-------------|
| `neko_navigate` | Navigate to URL, optionally in new tab |
| `neko_click` | Click element by index or coordinates |
| `neko_type` | Type text into element (keyboard events) |
| `neko_fill` | Set element text: uses Playwright's `fill()` for plain input/textarea, DOM assignment for contentEditable/other tags or when `html: true` |
| `neko_replace_text` | Clear and replace input/contentEditable text, optionally committing with a key |
| `neko_click_target` | Re-find one target by semantic conditions (including id/css), click it, and optionally wait for expected text |
| `neko_replace_target` | Re-find one editable target by semantic conditions (including id/css) and replace its text |
| `neko_arm_destructive` | Prepare a click target (including id/css conditions) and issue a short-lived one-time confirmation token without clicking |
| `neko_press_key` | Send keyboard key (Enter, Tab, etc.) |
| `neko_get_state` | Get page URL, title, interactive elements. `untrusted_notice` marks page-derived strings as untrusted data, not instructions. When `max_elements` (default 300) cuts the list, adds `truncated: true`, `total_candidates` (visible candidates across all frames) and `truncation_hint` |
| `neko_find_elements` | Find refreshed elements by text, role, automationid, id, css (main frame only), placeholder, or tag. Adds `truncated` / `total_candidates` / `truncation_hint` when the inspected elements were cut by `max_elements` |
| `neko_screenshot` | Capture page, element (by index), or clip-region screenshot, with optional mask for indexes/selectors (`mask_indexes` only matches elements that already have a `data-mcp-index`, i.e. interactive elements; use `mask_selectors` for anything else) |
| `neko_scroll` | Scroll page, or a specific element's scroll container (by index/selector), in up/down/left/right directions |
| `neko_scroll_into_view` | Scroll an element into view by index |
| `neko_go_back` | Navigate back in history |
| `neko_get_html` | Get HTML of page or element |
| `neko_list_tabs` | List all open tabs |
| `neko_switch_tab` | Switch to tab by ID |
| `neko_close_tab` | Close tab by ID |
| `neko_close` | Close the browser |
| `neko_upload_file` | Upload files (direct input or dialog mode) |
| `neko_evaluate` | Execute JavaScript in page context. A JavaScript exception thrown inside the page returns text starting with `PAGE_EXCEPTION` plus `name:` / `message:` (no `isError`). Tool failures (evaluation disabled, no session, page closed, context destroyed by navigation) set MCP `isError` |
| `neko_select` | Select dropdown option (by value/label/index) |
| `neko_wait_for` | Wait for selector, text across frames, navigation, URL match, load state, a JS condition, or `dom_stable_ms` (main frame DOM has no mutations for that many ms; fails at `timeout`; iframe contents are not observed; no evaluate gate needed) |
| `neko_handle_dialog` | Configure alert/confirm/prompt handling, optionally for the next dialog only (`once`) |
| `neko_hover` | Hover over element (tooltips, menus) |
| `neko_check` | Check/uncheck checkbox or radio |
| `neko_double_click` | Double-click element |
| `neko_drag` | Drag element from one index to another (blocked by default on Power Platform). Element indexing also matches plain `draggable="true"` elements, even without a role or tabindex |
| `neko_get_attribute` | Get element attribute(s) |
| `neko_get_value` | Read the actual value of an input/select/checkbox/contentEditable element (blocked by default on Power Platform) |
| `neko_get_alerts` | Collect alert/status/live-region text from all frames, including off-screen elements (not blocked on Power Platform) |
| `neko_snapshot` | Get a compact indexed snapshot of interactive elements (or structure), with optional selector scope and diff from previous snapshot. Adds a `truncated: true (analyzed N of M candidates ...)` line when `max_elements` cuts the list |
| `neko_get_text` | Get readable page text (innerText) by selector, index, or full page |
| `neko_network` | List, inspect, or clear recorded network requests (read-only, headers masked) |
| `neko_console` | List or clear recorded console messages and page errors |
| `neko_reload` | Reload the current page |
| `neko_go_forward` | Navigate forward in history |
| `neko_downloads` | List or clear recorded downloads (saved with original filenames, not GUIDs) |
| `neko_clipboard` | Write (overwrites the current OS clipboard content), paste (Control+V), or read clipboard content (`read` disabled by default; set `NEKO_BROWSER_ENABLE_EVALUATE=true` to allow it in a supervised debugging session) |

## Power Apps / Power Automate

Power Platformの式エディタやFluent UIでは、要素がiframe内にあり、入力欄に前回の値が残ったままになることがあります。

1. `neko_find_elements`で`role`、`automation_id`、`text`を使って対象を絞り込む
2. 返されたインデックスを直ちに`neko_replace_text`へ渡す
3. 必要な場合だけ`commit_key: "Enter"`を指定する
4. `neko_wait_for`に`text`を渡して保存完了・エラー表示などの動的状態を待つ

DOM再描画が頻繁な画面では、検索結果のindexを別の呼び出しで保持せず、`neko_click_target`または`neko_replace_target`を使う。これらは条件から対象を再同定し、複数一致を拒否し、SPAの再描画競合を再試行する。保存・送信などの操作では`expected_text`を指定して期待結果まで確認する。`neko_click_target`は誤クリック防止のため常に、`neko_arm_destructive`で対象を確認してから一回限りの`confirmation_token`を渡す。

要素インデックスはDOM更新で変わるため、保存や画面遷移の後は再検索する。自動保存・公開・削除などの不可逆操作は、既存のダイアログdismiss既定値と人手確認を維持する。

`neko_find_elements`・`neko_click_target`・`neko_replace_target`・`neko_arm_destructive`のid条件は大小区別ありの完全一致、css条件はメインフレームのみに適用され、現在の要素インデックスに載っている要素にしか一致しない。

Power Platformホストでは`neko_get_value`（要素の実値取得）と`neko_drag`（ドラッグ操作）を既定でブロックする。`neko_get_alerts`（アラート・通知文言の取得）はUI通知文言のみを対象とするためPower Platformでもブロックしない。

`neko_clipboard`の`read`はホストに関わらず既定で無効。OSクリップボードは総司令のデスクトップと共有される資源のため、`NEKO_BROWSER_ENABLE_EVALUATE=true`を設定した監督下でのみ許可する。`write`（現在のOSクリップボード内容を上書きする）と`paste`は入力支援のため常に許可する。

## Installation

```bash
npm install
npm run build
```

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `NEKO_BROWSER_PROFILE` | `~/.neko-browser/profile` | Profile directory path |
| `NEKO_BROWSER_HEADLESS` | `false` | Set to `true` for headless mode |
| `NEKO_BROWSER_ALLOW_RAW_POWER_PLATFORM_ACTIONS` | `false` | Allow legacy index/coordinate actions, raw page text export (`neko_get_text`), element value reads (`neko_get_value`), and drag (`neko_drag`) on Power Platform only during supervised debugging |
| `NEKO_BROWSER_ENABLE_EVALUATE` | `false` | Enable arbitrary page JavaScript and clipboard read (`neko_clipboard` action=read) only during supervised debugging |
| `NEKO_BROWSER_ENABLE_HTML_EXPORT` | `false` | Enable raw HTML export only during supervised debugging |
| `NEKO_BROWSER_DOWNLOAD_DIR` | `~/.neko-browser/downloads` | Download directory; absolute path only (relative paths fall back to default). Directory is created automatically if missing |

Power Apps、Power Automate、Dynamics 365、Power Pages（商用・政府クラウドを含む）の主要ホスト、またはそれらをiframeに埋め込むTeams・SharePointなどのページでは、旧来のindex・座標・ファイルアップロード操作を既定で停止する。通常は条件指定APIを使い、旧フローの保守時だけ`NEKO_BROWSER_ALLOW_RAW_POWER_PLATFORM_ACTIONS=true`を明示する。

## マルチプロファイル運用（複数アカウント同時起動）

SharePointなどで複数ロール（教育委員会/学校管理者/教員/システム管理者等）を並行して実機確認する場合、単一プロファイルのCookieを使い回すとアカウントを取り違える事故につながる。スロットごとにプロファイルとラベルを分けたMCPサーバ定義を用意することで、アカウントごとに独立したブラウザ窓を同時に起動できる。

### スロット一覧

| スロット | 用途 |
|---------|------|
| `neko-browser` | 既定（既存プロファイルをそのまま使用） |
| `neko-browser-a` | 追加スロットA |
| `neko-browser-b` | 追加スロットB |
| `neko-browser-c` | 追加スロットC |
| `neko-browser-d` | 追加スロットD |

各スロットはMCP設定に個別のサーバエントリとして追加し、`NEKO_BROWSER_PROFILE`でプロファイルディレクトリを分け、`NEKO_BROWSER_LABEL`で識別ラベルを付ける。

```json
{
  "mcpServers": {
    "neko-browser-a": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/neko-browser",
      "env": {
        "NEKO_BROWSER_PROFILE": "~/.neko-browser/profile-a",
        "NEKO_BROWSER_LABEL": "A"
      }
    }
  }
}
```

`b`/`c`/`d`も同様に、`NEKO_BROWSER_PROFILE`を`~/.neko-browser/profile-b`のようにスロットごとへ変えて追加する。

### ラベルの反映箇所

`NEKO_BROWSER_LABEL`で設定したラベルは以下の4箇所に反映され、人間とエージェントの双方がどの窓を操作しているか識別できる。

- 起動時のstderrログ（`label=`として表示）
- `neko_get_state`のレスポンスJSON先頭（`profile_label` / `profile_dir`）
- タブのfavicon（アイコン右下にラベルの丸バッジを重畳表示）
- ウィンドウタイトルの先頭（`猫ブラウザA | `形式のプレフィックス）

`NEKO_BROWSER_LABEL`を設定しない場合は、これら4箇所とも既存プロファイル（`neko-browser`スロット）と同じ表示・挙動になる。

### ウィンドウの初期配置

複数スロットを同時に起動すると、`NEKO_BROWSER_LABEL`で設定したラベル(A/B/C/D)に応じてウィンドウの初期位置がカスケード状にずれる。同じ位置に4つの窓が重なって見分けがつかなくなる事故を防ぐための機能。

- 基準サイズ: 幅1280px × 高さ760px
- カスケードのオフセット: 1段あたり80px（A→B→C→Dの順に右下へずれる）
- 既定値は1920×1080ディスプレイのタスクバーを除く作業領域（1920×1032、2026-08-21実測）にD窓まで収まるよう選定している。異なる解像度の環境では画面外にはみ出す可能性がある
- ラベルがA/B/C/D以外の場合は位置指定を行わない（サイズのみ既定値を適用し、位置はOS任せになる）

環境変数で上書きできる。画面解像度が既定の配置と合わない場合に調整する用途。

| 環境変数 | 書式 | 内容 |
|---------|------|------|
| `NEKO_BROWSER_WINDOW_POSITION` | `x,y`（カンマ区切りの正整数2つ） | ウィンドウの初期表示位置を上書き |
| `NEKO_BROWSER_WINDOW_SIZE` | `幅,高さ`（カンマ区切りの正整数2つ） | ウィンドウの初期サイズを上書き |

不正な書式（数値2つのカンマ区切り以外）を指定した場合は既定値にフォールバックする。

**重要**: Chromiumは永続プロファイルにウィンドウ位置を記憶する。この起動引数はあくまで初回の初期配置として機能するものであり、一度ウィンドウを人手で並べ替えると、次回以降の起動ではこの起動引数より記憶された配置が優先され、その並びが維持される。

`NEKO_BROWSER_LABEL`を設定しない既定の`neko-browser`スロットには、この初期配置は適用されない（起動引数自体が付与されない）。

### ウィンドウタイトルのプレフィックス

ラベル設定時は、ページのウィンドウタイトル先頭に`猫ブラウザA | `形式のプレフィックスが付く。SPAがタイトルを書き換えても追従する。

- `NEKO_BROWSER_TITLE_PREFIX`に`false`を設定すると無効化できる（既定は有効）。顧客提出用スクリーンショットにラベルを写したくない場合に使う
- `NEKO_BROWSER_LABEL`を設定しない既定の`neko-browser`スロットには適用されない
- 既知の制約: `about:blank`ではプレフィックスが付かない（実害なし）

### ロックとスロット間の並行動作

ロックはサーバプロセスごとに管理されるため、異なるスロット同士は並行して動作できる。同一スロットへの同時操作は従来通りブロックされる。

### 注意事項

- 新規スロットはCookieが空の状態で起動するため、初回はログインが必要
- MCPサーバ設定を追加・変更した後は、反映のためにClaude Codeの再起動が必要

## Usage (MCP)

Add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "neko-browser": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/neko-browser"
    }
  }
}
```

## License

MIT
