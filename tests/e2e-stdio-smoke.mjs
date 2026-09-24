// -----------------------------------------------------------------------------
// 猫ブラウザ e2e stdio スモークテスト（陽性コントロール用）
// -----------------------------------------------------------------------------
// 目的: 新ツール7本(neko_snapshot/neko_get_text/neko_network/neko_console/
//       neko_reload/neko_go_forward/neko_downloads)実装前後の差分を、実際に
//       MCPクライアントからstdio経由でdist/index.jsを子プロセス起動して検証する。
//       単体テストでは確認できない「MCPサーバとして起動して応答するか」を見る。
//       検証17-22は総司令追加依頼(REQ-20260904-001、P1-6ダウンロード保存名修正+
//       neko_downloads)分。既存検証1-16は無変更(内容も番号もそのまま)。
//       検証23以降は第2弾(design-p2-contract.md)分。新設5ツール(neko_scroll_into_view/
//       neko_get_alerts/neko_get_value/neko_drag/neko_clipboard)の存在確認(NEW_TOOLS
//       ループに合流)+実呼び出し14項目、既存5ツールの拡張(neko_scroll/neko_screenshot/
//       neko_find_elements/neko_fill/neko_handle_dialog)の実呼び出しを検証する。
//       既存検証1-22のコード(name文字列・引数・判定ロジック)は無変更。
// 実行: node tests/e2e-stdio-smoke.mjs
//       exit 0 = 全41項目PASS / exit 1 = いずれかFAILまたは異常終了
// 注意: このスクリプトはビルドを行わない。dist/ は呼び出し元が管理する前提。
// -----------------------------------------------------------------------------

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// このファイルの場所からリポジトリルートとdist/index.jsの絶対パスを組み立てる
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_INDEX = path.join(REPO_ROOT, 'dist', 'index.js');

// 今回追加予定の新ツール6本(第1弾)+5本(第2弾, design-p2-contract.md)。
// ベースライン(未実装状態)ではtools/listに含まれないことを陽性コントロールとして
// 確認する対象。この配列に追加すると下のループの実行回数(=record呼び出し回数)が
// そのまま増える(検証1-6が検証1-11になる)。EXPECTED_CHECK_COUNTの調整箇所参照。
const NEW_TOOLS = [
  'neko_snapshot',
  'neko_get_text',
  'neko_network',
  'neko_console',
  'neko_reload',
  'neko_go_forward',
  // --- 第2弾(design-p2-contract.md)追加分 ---
  'neko_scroll_into_view',
  'neko_get_alerts',
  'neko_get_value',
  'neko_drag',
  'neko_clipboard',
];

// 検証項目の期待総数。実行数がこれと一致しなければ「未実行の項目がある」
// とみなしFAILにする(0件でも成功扱いになる、といった構造を避けるための安全弁)
// 16(既存・無変更) + 6(検証17-22: download関連追加分) + 19(検証23以降:
// 第2弾追加分。NEW_TOOLSループ5件+実呼び出し14件) = 41
const EXPECTED_CHECK_COUNT = 41;
// 全体タイムアウト(ms)。ハングした場合でも非ゼロ終了させるための上限
// download未実装時はポーリングが毎回上限まで待つため既存180000msから延長した(上限300000ms)
const TIMEOUT_MS = 220000;
// クリーンアップが完了しない場合の強制終了までの猶予(ms)
const FORCE_EXIT_GRACE_MS = 8000;
// ダウンロード完了待ちポーリングの設定(1回あたり最大 200ms×60回=12秒。無限ループを避けるため試行回数で打ち切る)
// 仕事猫指摘(2026-09-04)によりFAILの見かけ上の速さ(=予約ファイルを即PASS判定)が解消されたため、
// 実際のsaveAs完了を待てるよう既存30回から60回へ延長した
const DOWNLOAD_POLL_INTERVAL_MS = 200;
const DOWNLOAD_POLL_MAX_ATTEMPTS = 60;

// --- ベースライン(新ツール未実装)での期待結果を先に書いておく ---------------
// 検証1-6  (新ツール存在確認 x6)      : 全てFAIL (現状tools/listに含まれないため)
// 検証7   (neko_navigate回帰確認)     : PASS (既存ツールのため)
// 検証8   (neko_snapshot要素確認)     : FAIL (ツール未実装でError:応答)
// 検証9   (snapshot/get_state文字数比較) : FAIL (snapshot側がError:応答のため無効)
// 検証10  (neko_get_textマーカー)     : FAIL (ツール未実装)
// 検証11  (neko_network)             : FAIL (ツール未実装)
// 検証12  (neko_console)             : FAIL (ツール未実装)
// 検証13  (neko_wait_for load_state単独) : FAIL (load_stateは未実装引数のため
//          "Error: Either selector, text, or navigation=true is required"が返る。
//          新ツール実装後は"Load state reached: load"を含む応答に変わる想定)
// 検証14  (neko_wait_for selector併用の回帰確認) : PASS (既存ツールのため)
// 検証15  (neko_reloadエラー無し)     : FAIL (ツール未実装でError:応答)
// 検証16  (neko_go_forward: エラー無し+戻り先URLが/next) : FAIL (ツール未実装でError:応答。
//          準備動作としてneko_go_backで/next→/に戻ってからgo_forwardを呼ぶ構成。
//          実装後は"Current page: <baseUrl>/next"を含む応答を期待)
// --- ここから検証17-22: P1-6(ダウンロード保存名修正+neko_downloads)追加分 -----
// 検証17  (tools/listにneko_downloadsが含まれる)         : FAIL (ツール未実装)
// 検証18  (ASCII名CSVの保存名がreport.csvになる)          : FAIL (download未実装のため
//          NEKO_BROWSER_DOWNLOAD_DIRに一切保存されない。ポーリング上限まで待って未検出)
// 検証19  (日本語名CSVの原名(売上データ.csv)が維持される)  : FAIL (同上)
// 検証20  (2回目クリックで連番report (1).csvになる)        : FAIL (同上。1回目すら保存されない)
// 検証21  (neko_downloads action=listにcompleted2件以上)  : FAIL (ツール未実装でError:応答)
// 検証22  (保存ファイルの中身がサーバ送出内容と一致)        : FAIL (ファイル自体が存在せず比較不能)
// --- ここから検証23以降: 第2弾(design-p2-contract.md)追加分 -------------------
// 検証23-27(NEW_TOOLSループに合流。tools/listに新設5ツールneko_scroll_into_view/
//           neko_get_alerts/neko_get_value/neko_drag/neko_clipboardが含まれる)
//                                                              : 全てFAIL (未実装)
// 検証28  (neko_scroll: direction指定のみの回帰確認。(80% of viewport)を含む)
//                                                              : PASS (既存ツールのため)
// 検証29  (neko_get_alerts: viewport外のrole=alertをスクロールなしで取得)
//                                                              : FAIL (ツール未実装)
// 検証30  (neko_scroll: index+amount_px指定でcontainer/scrollTop=を含む)
//                                                              : FAIL (拡張未実装。
//          現行スキーマにindex/amount_px引数が無いため無視され80%viewport動作に
//          フォールバックする、またはスキーマ検証でエラーになる想定)
// 検証31  (neko_scroll_into_view: viewport外要素でin_viewport=trueを含む)
//                                                              : FAIL (ツール未実装)
// 検証32  (neko_find_elements: id引数でbtnShareのみ取得、キャンセルボタンは含まない)
//                                                              : FAIL (id引数未実装。
//          無視されて全件返しになった場合はキャンセルボタンの文言も含まれるためFAILする設計)
// 検証33  (neko_find_elements: css引数(#btnShare)で同様にbtnShareのみ取得)
//                                                              : FAIL (css引数未実装。理由は検証32と同じ)
// 検証34  (neko_fill: input要素へのfillで出力が"with value:"を含む)
//                                                              : FAIL (fill自動振り分け未実装の想定。
//          ただし現行のmode変数の値が偶然"value"であれば意図せずPASSする可能性はゼロではない
//          [evidence: suspicion] — 現行実装未確認のため断定不可)
// 検証35  (neko_get_value: fill後の実値を返しHTML初期値(initial-value)と異なる)
//                                                              : FAIL (ツール未実装)
// 検証36  (neko_clipboard: 日本語write→paste後、neko_get_valueで化けずに取得)
//                                                              : FAIL (ツール未実装)
// 検証37  (neko_upload_file: iframe内input[type=file]にindex指定で投入)
//                                                              : FAIL (id属性未実装のため
//          frameFileInputIndexの取得自体が不能。iframe対応そのものの実測にはならない
//          [evidence: suspicion] — id実装後に別途trigger_indexモードも実測が必要)
// 検証38  (neko_screenshot: mask_indexes指定でキャプションが"masked="を含む)
//                                                              : FAIL (mask_indexes未実装)
// 検証39  (neko_screenshot: 引数なしでキャプションが"fullPage="を含む回帰確認)
//                                                              : PASS (既存ツールのため)
// 検証40  (neko_handle_dialog: once:true後の2回目が既定のdismissに戻る)
//                                                              : FAIL (once引数未実装。
//          無視された場合、1回目・2回目とも同じdialogAction(accept)のままになる想定)
// 検証41  (neko_drag: index_from/index_toでItem AをItem Cへドラッグし並び順が変わる)
//                                                              : FAIL (ツール未実装)
// => 検証23以降(19項目)のうちPASS=2(検証28,39)/FAIL=17が期待値。
// => 合計41項目の期待値: PASS=4(検証7,14 [既存分] + 検証28,39 [本ブロック分]) / FAIL=37。
//    全体はFAIL(exit 1)になるはず。
// -----------------------------------------------------------------------------

/** 検証結果の記録先(モジュールスコープで1本化。経路が2通りにならないようにする) */
const checks = [];

// 1件の検証結果を記録し、その場でPASS/FAILを1行標準出力に出す
function record(name, ok, detail) {
  checks.push({ name, ok });
  const mark = ok ? '[PASS]' : '[FAIL]';
  console.log(detail ? `${mark} ${name} — ${detail}` : `${mark} ${name}`);
}

// MCPツール応答のcontent配列からテキスト本文(先頭のtext要素)を取り出す
function extractText(result) {
  if (!result || !Array.isArray(result.content)) return '';
  const textItem = result.content.find((c) => c && c.type === 'text');
  return textItem ? String(textItem.text ?? '') : '';
}

// ツール呼び出しを例外ごと吸収する。例外時もFAIL判定の材料になるテキストを返す。
// (try-catchで例外を握ってPASS扱いにする経路は作らない。あくまでFAIL側の情報として使う)
async function safeCallTool(client, name, args) {
  try {
    const result = await client.callTool({ name, arguments: args ?? {} });
    return { text: extractText(result), threw: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: `Error: (exception while calling ${name}) ${message}`, threw: true };
  }
}

// 指定Promiseにタイムアウトを付与する。タイムアウト時はエラーでreject
function withTimeout(promise, ms, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}がタイムアウトした(${ms}ms)`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

// --- P1-6(ダウンロード)検証用ヘルパー ---------------------------------------

// neko_get_stateのJSON応答(interactive_elements)から、href末尾一致で要素indexを探す。
// JSONパース失敗時・該当無し時はnullを返す(呼び出し側でFAIL扱いにするための合図)。
function findElementIndexByHrefSuffix(stateText, hrefSuffix) {
  try {
    const state = JSON.parse(stateText);
    const elements = Array.isArray(state.interactive_elements) ? state.interactive_elements : [];
    const found = elements.find(
      (el) => el && typeof el.href === 'string' && el.href.endsWith(hrefSuffix),
    );
    return found ? found.index : null;
  } catch {
    return null;
  }
}

// --- P2検証(design-p2-contract.md)用ヘルパー -------------------------------

// neko_get_stateのJSON応答(interactive_elements)から、id属性の完全一致で要素indexを探す。
// design-p2-contract.md機能3で追加されるElementInfo.idフィールドに依存するため、
// 未実装のうちは常にnullを返す(=陽性コントロールとして機能する)。
// JSONパース失敗時・該当無し時もnullを返す(呼び出し側でFAIL扱いにするための合図)。
function findElementIndexById(stateText, idValue) {
  try {
    const state = JSON.parse(stateText);
    const elements = Array.isArray(state.interactive_elements) ? state.interactive_elements : [];
    const found = elements.find((el) => el && el.id === idValue);
    return found ? found.index : null;
  } catch {
    return null;
  }
}

// neko_downloadsのlist出力テキストから、savedPath(矢印"-> "の後ろ)のファイル名部分(basename)が
// 指定名と一致する行のstatusトークンを返す。見つからなければnull。
// in_progress行はsavedPathが空文字(矢印の後ろが空)なのでbasenameが一致せず自然にスキップされる。
// suggestedFilenameは複数回のダウンロードで同じ値になりうる(例: report.csvを2回)ため、
// 表示名ではなく実際に保存されたファイル名(savedPath側。連番付きなら区別できる)で照合する
// (仕事猫指摘2026-09-04: 1回目/2回目のreport.csvエントリ混同を避けるため)。
function findDownloadStatusBySavedBasename(listText, expectedBasename) {
  const lines = listText.split('\n');
  for (const line of lines) {
    const arrowIndex = line.indexOf('-> ');
    if (arrowIndex === -1) continue;
    let afterArrow = line.slice(arrowIndex + 3);
    // completed行末尾のサイズ表記(例: " 1234B")を取り除いてパス部分だけにする
    afterArrow = afterArrow.replace(/ \d+B$/, '');
    if (afterArrow.length === 0) continue; // in_progress行(savedPath未確定)はスキップ
    if (path.basename(afterArrow) === expectedBasename) {
      const statusMatch = line.match(/^#\d+\s+(\S+)\s+/);
      if (statusMatch) return statusMatch[1];
    }
  }
  return null;
}

// ダウンロード完了を「保存先ファイルのサイズが0より大きい」かつ「neko_downloadsのlistで対応エントリが
// completedになっている」の両方で判定する。0バイトの予約プレースホルダ(findAvailableDownloadPathが
// TOCTOU対策でopenSync(candidate,'wx')により事前作成するもの)だけを見て誤ってPASS判定しないための対策
// (仕事猫指摘2026-09-04: fs.existsSyncだけの判定は予約直後の0バイトファイルで即座に真になっていた)。
// Date.now()等による経過時間計算は使わず、試行回数の上限だけで打ち切る(無限ループ回避)。
async function waitForDownloadCompleted(client, filePath, maxAttempts, intervalMs) {
  const expectedBasename = path.basename(filePath);
  let lastSizeBytes = null;
  let lastStatus = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      lastSizeBytes = fs.statSync(filePath).size;
    } catch {
      lastSizeBytes = null; // まだ存在しない、または予約前
    }
    // サイズが0より大きい(=予約プレースホルダではなく実データが書き込まれた)場合のみ、
    // neko_downloads側の記録も突き合わせる(MCP往復はここでだけ発生させ、ポーリング全体を軽く保つ)
    if (lastSizeBytes !== null && lastSizeBytes > 0) {
      const listResult = await safeCallTool(client, 'neko_downloads', { action: 'list' });
      lastStatus = findDownloadStatusBySavedBasename(listResult.text, expectedBasename);
      if (lastStatus === 'completed') {
        return { ok: true, sizeBytes: lastSizeBytes, status: lastStatus };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  // タイムアウト直前にもう一度neko_downloadsを見て、判定メッセージ用の最終状態を残す
  try {
    lastSizeBytes = fs.statSync(filePath).size;
  } catch {
    lastSizeBytes = null;
  }
  const finalListResult = await safeCallTool(client, 'neko_downloads', { action: 'list' });
  lastStatus = findDownloadStatusBySavedBasename(finalListResult.text, expectedBasename);
  return {
    ok: lastSizeBytes !== null && lastSizeBytes > 0 && lastStatus === 'completed',
    sizeBytes: lastSizeBytes,
    status: lastStatus,
  };
}

// --- テストサーバが配信する固定コンテンツ(架空データのみ・実在情報なし) -----
const PAGE_HTML = `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8"><title>猫ブラウザE2Eスモーク</title></head>
<body>
<h1>猫ブラウザE2Eスモークテスト</h1>
<nav aria-label="サイトナビ"><a href="/">ホーム</a></nav>
<button>保存</button>
<input placeholder="氏名">
<p>これは猫ブラウザのE2Eスモークテスト用に用意した架空の本文テキストです。山田太郎という架空の名前を含みます。</p>
<a href="/next">次へ</a>
<script src="/app.js"></script>
</body>
</html>`;

const NEXT_PAGE_HTML = `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8"><title>次のページ</title></head>
<body>
<h1>次のページ</h1>
<p>neko_reload / neko_go_forward 確認用の遷移先ページです。</p>
</body>
</html>`;

const APP_JS = `// e2eスモークテスト用スクリプト: APIを1回叩き、コンソールエラーを1回出す
fetch('/api/data').then((r) => r.json()).catch(() => {});
console.error('e2e smoke error marker');
`;

// --- P1-6検証用: ダウンロードリンク専用ページ(架空データのみ・実在情報なし) --------
// 既存PAGE_HTMLには追加しない。要素数が変わると検証8/9(要素数・文字数比較)に
// 意図しない影響が出るため、独立ページに分離した。
const DOWNLOAD_PAGE_HTML = `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8"><title>ダウンロード確認ページ</title></head>
<body>
<h1>ダウンロード確認ページ</h1>
<p>neko_downloads検証用の架空データダウンロードリンクです。</p>
<a href="/download/report.csv">ASCII名CSVダウンロード</a>
<a href="/download/japanese.csv">日本語名CSVダウンロード</a>
</body>
</html>`;

// --- P2検証用(design-p2-contract.md): id/css条件・get_value/fill・clipboard・
//     handle_dialog・iframe uploadを1ページにまとめたページ(架空データのみ・実在情報なし) --
// 既存PAGE_HTMLには追加しない(要素数変化で検証8/9に影響するため独立ページに分離)。
// cancelBtnはid/css条件検証(検証32/33)で「未実装時に全件返しになった場合はこの文言も
// 含まれてしまう」という差分判定のためのダミー要素(意図せずPASSする事故の防止策)。
const PAGE2_HTML = `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8"><title>猫ブラウザE2Eスモーク P2</title></head>
<body>
<h1>P2検証ページ</h1>
<button id="btnShare">共有</button>
<button id="cancelBtn">キャンセル</button>
<input id="valueInput" value="initial-value">
<input id="clipInput" value="">
<button id="dialogBtn" onclick="document.getElementById('dialogResult').textContent = confirm('猫会議に参加しますか') ? 'accepted' : 'dismissed'">ダイアログ表示</button>
<div id="dialogResult">none</div>
<iframe id="uploadFrame" src="/p2-upload-frame" title="アップロード用フレーム"></iframe>
</body>
</html>`;

// --- P2検証用: iframe内にfile inputを1つだけ持つフレームページ(neko_upload_fileのiframe対応検証用) --
const P2_UPLOAD_FRAME_HTML = `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8"><title>アップロードフレーム</title></head>
<body>
<input type="file" id="frameFileInput">
</body>
</html>`;

// --- P2検証用: overflow:autoの固定高さスクロールコンテナ+viewport外要素を持つページ ---------
// (架空データのみ・実在情報なし)。scrollBox内の項目2リンクはneko_scroll(index)対象、
// 末尾のscrollIntoViewTargetはneko_scroll_into_view対象、その先のrole=alertは
// neko_get_alerts対象(いずれもページ読込直後のスクロール位置0でviewport外にある想定)。
const PAGE2_SCROLL_HTML = `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8"><title>P2スクロール確認</title></head>
<body>
<h1>P2スクロール確認ページ</h1>
<div id="scrollBox" style="height:150px; overflow:auto; border:1px solid #000;">
<ul style="margin:0; padding:0; list-style:none;">
<li style="height:60px;">項目1</li>
<li style="height:60px;"><a href="#itemLink" id="scrollListLink">項目2リンク</a></li>
<li style="height:60px;">項目3</li>
<li style="height:60px;">項目4</li>
<li style="height:60px;">項目5</li>
<li style="height:60px;">項目6</li>
<li style="height:60px;">項目7</li>
<li style="height:60px;">項目8</li>
<li style="height:60px;">項目9</li>
<li style="height:60px;">項目10</li>
</ul>
</div>
<div style="height:2000px;">余白</div>
<a href="#farLink" id="scrollIntoViewTarget">遠くのリンク(viewport外)</a>
<div style="height:500px;">余白2</div>
<div role="alert">P2アラートメッセージ(viewport外)</div>
</body>
</html>`;

// --- P2検証用: HTML5 Drag and Dropで並び替え可能な3項目リストのページ(架空データのみ) ---------
// neko_dragでItem AをItem Cへドラッグすると[Item B, Item C, Item A]の順になる想定
// (dropハンドラでinsertBefore(dragSrc, target.nextSibling)=targetの直後に挿入するため)。
const PAGE2_DRAG_HTML = `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8"><title>P2ドラッグ確認</title></head>
<body>
<h1>P2ドラッグ確認ページ</h1>
<ul id="dragList" style="list-style:none; padding:0;">
<li draggable="true" id="dragItemA" style="padding:10px; border:1px solid #000;">Item A</li>
<li draggable="true" id="dragItemB" style="padding:10px; border:1px solid #000;">Item B</li>
<li draggable="true" id="dragItemC" style="padding:10px; border:1px solid #000;">Item C</li>
</ul>
<script>
(function () {
  var list = document.getElementById('dragList');
  var dragSrc = null;
  list.addEventListener('dragstart', function (e) {
    dragSrc = e.target;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', e.target.id);
  });
  list.addEventListener('dragover', function (e) {
    e.preventDefault();
    return false;
  });
  list.addEventListener('drop', function (e) {
    e.preventDefault();
    if (dragSrc && dragSrc !== e.target) {
      var target = e.target.closest('li');
      if (target) {
        list.insertBefore(dragSrc, target.nextSibling);
      }
    }
    return false;
  });
})();
</script>
</body>
</html>`;

// ASCII名(Content-Disposition: attachment; filename="report.csv")で配信するCSVの中身
const ASCII_CSV_FILENAME = 'report.csv';
const ASCII_CSV_CONTENT = 'date,item,amount\n2026-01-01,cat snack,1200\n2026-01-02,cat litter,800\n';

// 日本語名(Content-Disposition: attachment; filename*=UTF-8''...)で配信するCSVの中身
const JAPANESE_CSV_FILENAME = '売上データ.csv';
const JAPANESE_CSV_CONTENT = '日付,商品,金額\n2026-01-01,ねこ用おやつ,1200\n2026-01-02,ねこ砂,800\n';

// ローカルHTTPサーバを起動する(ポート0でOS任せ、127.0.0.1限定=外部通信なし)
function startLocalServer() {
  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    if (url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
    } else if (url === '/app.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(APP_JS);
    } else if (url === '/api/data') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    } else if (url === '/next') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(NEXT_PAGE_HTML);
    } else if (url === '/downloads') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(DOWNLOAD_PAGE_HTML);
    } else if (url === '/download/report.csv') {
      // ASCII名をfilename=でそのまま指定する(陽性コントロール: 現状はGUID名で保存される想定)
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${ASCII_CSV_FILENAME}"`,
      });
      res.end(ASCII_CSV_CONTENT);
    } else if (url === '/download/japanese.csv') {
      // RFC 5987/6266形式のfilename*=UTF-8''でエンコードした日本語名を指定する(原名維持確認用)
      const encodedName = encodeURIComponent(JAPANESE_CSV_FILENAME);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodedName}`,
      });
      res.end(JAPANESE_CSV_CONTENT);
    } else if (url === '/p2') {
      // P2検証用(design-p2-contract.md): id/css・get_value/fill・clipboard・handle_dialog・iframe upload
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE2_HTML);
    } else if (url === '/p2-upload-frame') {
      // P2検証用: /p2のiframeが読み込むフレーム内ページ(file input検証用)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(P2_UPLOAD_FRAME_HTML);
    } else if (url === '/p2-scroll') {
      // P2検証用: scroll(container)/scroll_into_view/get_alerts検証用ページ
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE2_SCROLL_HTML);
    } else if (url === '/p2-drag') {
      // P2検証用: neko_drag検証用のHTML5 DnDページ
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE2_DRAG_HTML);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // 明示的に127.0.0.1へバインドし、外部からの到達性を持たせない
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// 子プロセスへ渡す環境変数を組み立てる。総司令の常用プロファイルは絶対に使わせない
function buildChildEnv(profileDir, downloadDir) {
  const env = { ...process.env };
  // Power Platform生操作・JS評価・HTML全量出力は既定OFFのまま起動させる(delete=未継承)
  delete env.NEKO_BROWSER_ENABLE_EVALUATE;
  delete env.NEKO_BROWSER_ENABLE_HTML_EXPORT;
  delete env.NEKO_BROWSER_ALLOW_RAW_POWER_PLATFORM_ACTIONS;
  env.NEKO_BROWSER_HEADLESS = 'true';
  env.NEKO_BROWSER_PROFILE = profileDir;
  // ダウンロード保存先を一時ディレクトリに固定する(総司令の実ダウンロードフォルダ・
  // 既定の~/.neko-browser/downloads/は使わせない)。現行distは未実装のため無視されるが、
  // 実装後もそのまま有効な設計にしておく
  env.NEKO_BROWSER_DOWNLOAD_DIR = downloadDir;
  // process.envはundefined値を含みうるため、StdioServerParameters.envの型に合わせて除去する
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return env;
}

async function main() {
  // --- 一時プロファイルディレクトリ(os.tmpdir()配下限定で作成) ---
  const tmpProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-browser-e2e-'));
  // --- P1-6検証用: 一時ダウンロードディレクトリ(os.tmpdir()配下限定で作成。
  //     総司令の実ダウンロードフォルダ・既定の~/.neko-browser/downloads/は使わない) ---
  const tmpDownloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-browser-e2e-downloads-'));
  // --- P2検証用(design-p2-contract.md機能6): neko_upload_fileテストで使う一時ファイル。
  //     プロファイルディレクトリとは独立させる(ブラウザのユーザーデータ領域に無関係な
  //     ファイルを置かないため) ---
  const tmpUploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-browser-e2e-upload-'));
  const tmpUploadFilePath = path.join(tmpUploadDir, 'p2-upload-test.txt');
  fs.writeFileSync(tmpUploadFilePath, 'neko-browser p2 e2e upload test file\n', 'utf-8');

  let httpServer;
  let client;
  try {
    httpServer = await startLocalServer();
    const port = httpServer.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    console.log(`[INFO] ローカルテストサーバ起動: ${baseUrl}`);
    console.log(`[INFO] 一時プロファイル: ${tmpProfileDir}`);
    console.log(`[INFO] 一時ダウンロードディレクトリ: ${tmpDownloadDir}`);

    // --- MCPクライアントをdist/index.js子プロセスに接続する ---
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_INDEX],
      cwd: REPO_ROOT,
      env: buildChildEnv(tmpProfileDir, tmpDownloadDir),
    });
    client = new Client({ name: 'e2e-stdio-smoke', version: '0.0.0' });
    await client.connect(transport);
    console.log('[INFO] MCPクライアント接続完了(initializeハンドシェイク成功)');

    // === 検証1-6: tools/list に新ツール6本が含まれること ===
    const toolsList = await client.listTools();
    const toolNames = new Set((toolsList.tools ?? []).map((t) => t.name));
    for (const name of NEW_TOOLS) {
      record(`tools/list に ${name} が含まれる`, toolNames.has(name));
    }

    // === 検証7: neko_navigate でローカルサーバへ遷移できること(既存ツール回帰確認) ===
    const navResult = await safeCallTool(client, 'neko_navigate', { url: `${baseUrl}/` });
    record(
      'neko_navigate でローカルサーバへ遷移できる',
      !navResult.threw && /^Navigated to:/.test(navResult.text),
      navResult.text.slice(0, 100).replace(/\n/g, ' '),
    );

    // === 検証8: neko_snapshot の出力に「[」付き要素行2行以上+"保存"を含むこと ===
    const snapshotResult = await safeCallTool(client, 'neko_snapshot', {});
    const snapshotElementLines = snapshotResult.text.split('\n').filter((line) => line.includes('['));
    const snapshotOk =
      !snapshotResult.threw &&
      !snapshotResult.text.startsWith('Error:') &&
      snapshotElementLines.length >= 2 &&
      snapshotResult.text.includes('保存');
    record(
      'neko_snapshot の出力が「[」付き要素行2行以上+"保存"を含む',
      snapshotOk,
      `element_lines=${snapshotElementLines.length}`,
    );

    // === 検証9: neko_snapshot出力文字数がneko_get_state出力文字数の1/3以下(両方実測) ===
    const stateResult = await safeCallTool(client, 'neko_get_state', {});
    const snapshotLen = snapshotResult.text.length;
    const stateLen = stateResult.text.length;
    // どちらかがError:応答(=未実装/失敗)の場合は比較そのものが無意味なためFAIL扱いにする
    const bothValid =
      !snapshotResult.threw &&
      !snapshotResult.text.startsWith('Error:') &&
      !stateResult.threw &&
      !stateResult.text.startsWith('Error:');
    const lenOk = bothValid && snapshotLen <= stateLen / 3;
    record(
      `neko_snapshot出力文字数(${snapshotLen})がneko_get_state出力文字数(${stateLen})の1/3以下`,
      lenOk,
    );

    // === 検証10: neko_get_text の出力にマーカー行+本文一部を含むこと ===
    const getTextResult = await safeCallTool(client, 'neko_get_text', {});
    const getTextOk =
      !getTextResult.threw &&
      getTextResult.text.includes('--- BEGIN UNTRUSTED PAGE TEXT') &&
      getTextResult.text.includes('--- END UNTRUSTED PAGE TEXT') &&
      getTextResult.text.includes('猫ブラウザE2Eスモークテスト');
    record('neko_get_text の出力にマーカー行+本文一部を含む', getTextOk);

    // === 検証11: neko_network action=list に /app.js(200)+/api/data を含むこと ===
    const networkResult = await safeCallTool(client, 'neko_network', { action: 'list' });
    const networkOk =
      !networkResult.threw &&
      /\/app\.js/.test(networkResult.text) &&
      /200/.test(networkResult.text) &&
      networkResult.text.includes('/api/data');
    record('neko_network action=list に /app.js(status 200)+/api/data を含む', networkOk);

    // === 検証12: neko_console action=list に e2e smoke error marker(level=error) を含むこと ===
    const consoleResult = await safeCallTool(client, 'neko_console', { action: 'list' });
    const consoleOk =
      !consoleResult.threw &&
      consoleResult.text.includes('e2e smoke error marker') &&
      /error/i.test(consoleResult.text);
    record('neko_console action=list に e2e smoke error marker(level=error) を含む', consoleOk);

    // === 検証13: neko_wait_for に load_state:'load' を単独で渡すこと(陽性コントロール本体) ===
    // load_stateは現行スキーマに存在しない引数のため、他のパラメータを併用しない。
    // ベースラインでは selector/text/navigation いずれも無いため
    // "Error: Either selector, text, or navigation=true is required" が返り、必ずFAILする。
    // (selectorを併用するとload_state実装の有無に関わらずPASSしてしまい検証にならないため分離した)
    const waitForLoadStateResult = await safeCallTool(client, 'neko_wait_for', {
      load_state: 'load',
    });
    record(
      'neko_wait_for に load_state:load を単独で渡すと成功応答(Load state reached: load)が返る',
      !waitForLoadStateResult.threw &&
        !waitForLoadStateResult.text.startsWith('Error:') &&
        waitForLoadStateResult.text.includes('Load state reached: load'),
      waitForLoadStateResult.text.slice(0, 100).replace(/\n/g, ' '),
    );

    // === 検証14: neko_wait_for に selector を渡す既存経路が壊れていないこと(回帰確認) ===
    const waitForSelectorResult = await safeCallTool(client, 'neko_wait_for', { selector: 'h1' });
    record(
      'neko_wait_for に selector:h1 を渡して成功応答が返る(既存ツール回帰確認)',
      !waitForSelectorResult.threw && !waitForSelectorResult.text.startsWith('Error:'),
      waitForSelectorResult.text.slice(0, 100).replace(/\n/g, ' '),
    );

    // --- neko_reload/neko_go_forward確認のため/nextへ遷移しておく(検証対象外の準備動作) ---
    await safeCallTool(client, 'neko_navigate', { url: `${baseUrl}/next` });

    // === 検証15: neko_reload がエラー文字列を返さないこと ===
    const reloadResult = await safeCallTool(client, 'neko_reload', {});
    record(
      'neko_reload がエラー文字列を返さない',
      !reloadResult.threw && !reloadResult.text.startsWith('Error:'),
      reloadResult.text.slice(0, 100).replace(/\n/g, ' '),
    );

    // --- neko_go_forward確認のための準備動作: /next(検証15の対象)から一旦/へ戻る ---
    // (検証項目ではないが、これ自体が失敗するとgo_forwardの検証が無意味になるためログには残す)
    const goBackResult = await safeCallTool(client, 'neko_go_back', {});
    if (goBackResult.threw || goBackResult.text.startsWith('Error:')) {
      console.error(`[WARN] 準備動作のneko_go_backに失敗した(go_forward検証に影響する可能性あり): ${goBackResult.text}`);
    } else {
      console.log(`[INFO] neko_go_back完了(go_forward検証の準備動作): ${goBackResult.text.slice(0, 100).replace(/\n/g, ' ')}`);
    }

    // === 検証16: neko_go_forward がエラー文字列を返さず、戻り先URLが/nextであること ===
    // 前進履歴が無い状態(go_back未実施)でgo_forwardを呼ぶと実装仕様どおり
    // "Error: No forward history." が返る。これはテストシナリオの不備であり実装のバグではない
    // (仕事猫指摘・実装済みdistでの実測により判明)。go_back→go_forwardの順にして検証する
    const forwardResult = await safeCallTool(client, 'neko_go_forward', {});
    const forwardOk =
      !forwardResult.threw &&
      !forwardResult.text.startsWith('Error:') &&
      forwardResult.text.includes(`${baseUrl}/next`);
    record(
      'neko_go_forward がエラー文字列を返さず戻り先URLが/nextである',
      forwardOk,
      forwardResult.text.slice(0, 100).replace(/\n/g, ' '),
    );

    // === 検証17: tools/list に neko_downloads が含まれる ===
    // (NEW_TOOLS配列・検証1-6ループは既存のまま変更しない。toolNamesはそこで取得済みのSetを再利用)
    record('tools/list に neko_downloads が含まれる', toolNames.has('neko_downloads'));

    // --- ダウンロード確認ページへ遷移し、リンクの要素indexを取得する(検証対象外の準備動作) ---
    await safeCallTool(client, 'neko_navigate', { url: `${baseUrl}/downloads` });
    const downloadStateResult = await safeCallTool(client, 'neko_get_state', {});
    const asciiLinkIndex = findElementIndexByHrefSuffix(
      downloadStateResult.text,
      '/download/report.csv',
    );
    const japaneseLinkIndex = findElementIndexByHrefSuffix(
      downloadStateResult.text,
      '/download/japanese.csv',
    );
    if (asciiLinkIndex === null || japaneseLinkIndex === null) {
      console.error(
        `[WARN] ダウンロードリンクのindex取得に失敗した(ascii=${asciiLinkIndex}, japanese=${japaneseLinkIndex})。以降のdownload検証はリンク未検出としてFAILする`,
      );
    }

    // === 検証18: ASCII名CSVをダウンロードすると保存名がreport.csvになる(GUIDにならない) ===
    const asciiSavedPath = path.join(tmpDownloadDir, ASCII_CSV_FILENAME);
    let asciiClickResult = {
      threw: true,
      text: 'Error: link index not found (asciiLinkIndex is null)',
    };
    if (asciiLinkIndex !== null) {
      asciiClickResult = await safeCallTool(client, 'neko_click', { index: asciiLinkIndex });
    }
    const asciiDownload = await waitForDownloadCompleted(
      client,
      asciiSavedPath,
      DOWNLOAD_POLL_MAX_ATTEMPTS,
      DOWNLOAD_POLL_INTERVAL_MS,
    );
    record(
      'ASCII名CSVをダウンロードすると保存名がreport.csvになる(GUIDにならない)',
      !asciiClickResult.threw && asciiDownload.ok,
      `click_threw=${asciiClickResult.threw} size=${asciiDownload.sizeBytes} downloads_status=${asciiDownload.status}`,
    );

    // === 検証19: 日本語名CSVをダウンロードすると原名(売上データ.csv)が維持される ===
    const japaneseSavedPath = path.join(tmpDownloadDir, JAPANESE_CSV_FILENAME);
    let japaneseClickResult = {
      threw: true,
      text: 'Error: link index not found (japaneseLinkIndex is null)',
    };
    if (japaneseLinkIndex !== null) {
      japaneseClickResult = await safeCallTool(client, 'neko_click', { index: japaneseLinkIndex });
    }
    const japaneseDownload = await waitForDownloadCompleted(
      client,
      japaneseSavedPath,
      DOWNLOAD_POLL_MAX_ATTEMPTS,
      DOWNLOAD_POLL_INTERVAL_MS,
    );
    record(
      '日本語名CSVをダウンロードすると原名(売上データ.csv)が維持される',
      !japaneseClickResult.threw && japaneseDownload.ok,
      `click_threw=${japaneseClickResult.threw} size=${japaneseDownload.sizeBytes} downloads_status=${japaneseDownload.status}`,
    );

    // === 検証20: 同じリンクを2回踏むと2つ目が連番名report (1).csvで保存される(上書きされない) ===
    const asciiSavedPath2 = path.join(tmpDownloadDir, 'report (1).csv');
    let asciiClickResult2 = {
      threw: true,
      text: 'Error: link index not found (asciiLinkIndex is null)',
    };
    if (asciiLinkIndex !== null) {
      asciiClickResult2 = await safeCallTool(client, 'neko_click', { index: asciiLinkIndex });
    }
    const asciiDownload2 = await waitForDownloadCompleted(
      client,
      asciiSavedPath2,
      DOWNLOAD_POLL_MAX_ATTEMPTS,
      DOWNLOAD_POLL_INTERVAL_MS,
    );
    record(
      '同じリンクを2回踏むと2つ目が連番名report (1).csvで保存される(上書きされない)',
      !asciiClickResult2.threw && asciiDownload2.ok,
      `click_threw=${asciiClickResult2.threw} size=${asciiDownload2.sizeBytes} downloads_status=${asciiDownload2.status}`,
    );

    // === 検証21: neko_downloads の action=list に completed のエントリが2件以上出る ===
    const downloadsListResult = await safeCallTool(client, 'neko_downloads', { action: 'list' });
    const completedCount = (downloadsListResult.text.match(/\bcompleted\b/g) ?? []).length;
    record(
      'neko_downloads の action=list に completed のエントリが2件以上出る',
      !downloadsListResult.threw &&
        !downloadsListResult.text.startsWith('Error:') &&
        completedCount >= 2,
      `completed_count=${completedCount}`,
    );

    // === 検証22: 保存されたファイルの中身がサーバの送出内容と一致する ===
    let contentsMatch = false;
    let contentsDetail = 'files not saved(skip content compare)';
    if (asciiDownload.ok && japaneseDownload.ok) {
      try {
        const asciiActual = fs.readFileSync(asciiSavedPath, 'utf-8');
        const japaneseActual = fs.readFileSync(japaneseSavedPath, 'utf-8');
        const asciiMatch = asciiActual === ASCII_CSV_CONTENT;
        const japaneseMatch = japaneseActual === JAPANESE_CSV_CONTENT;
        contentsMatch = asciiMatch && japaneseMatch;
        contentsDetail = `ascii_match=${asciiMatch} japanese_match=${japaneseMatch}`;
      } catch (err) {
        contentsDetail = `read error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    record('保存されたファイルの中身がサーバの送出内容と一致する', contentsMatch, contentsDetail);

    // === P2検証(第2弾, design-p2-contract.md)ここから ==========================
    // tools/list確認(新設5ツール)はNEW_TOOLSループ(検証1-6相当が11回に増える)で
    // 既にカバー済みのため、ここでは実呼び出し検証のみを行う。

    // === 検証: neko_scroll に direction のみを渡す既存経路が壊れていないこと(回帰確認) ===
    const scrollRegressionResult = await safeCallTool(client, 'neko_scroll', { direction: 'down' });
    record(
      'neko_scroll に direction のみ渡すと(80% of viewport)を含む(既存ツール回帰確認)',
      !scrollRegressionResult.threw && scrollRegressionResult.text.includes('(80% of viewport)'),
      scrollRegressionResult.text.slice(0, 100).replace(/\n/g, ' '),
    );

    // --- /p2-scrollへ遷移(検証対象外の準備動作)。get_alerts検証をスクロール位置0で行うため最優先で呼ぶ ---
    await safeCallTool(client, 'neko_navigate', { url: `${baseUrl}/p2-scroll` });

    // === 検証: neko_get_alerts がスクロールせずにviewport外のrole=alertを取得できること ===
    const alertsResult = await safeCallTool(client, 'neko_get_alerts', {});
    const alertsOk =
      !alertsResult.threw &&
      !alertsResult.text.startsWith('Error:') &&
      alertsResult.text.includes('role=alert') &&
      alertsResult.text.includes('P2アラートメッセージ');
    record(
      'neko_get_alerts がスクロールせずにviewport外のrole=alertを取得できる',
      alertsOk,
      alertsResult.text.slice(0, 150).replace(/\n/g, ' '),
    );

    // --- /p2-scroll内のリンクindexを取得(検証対象外の準備動作。hrefベースなので既存ヘルパーを再利用) ---
    const p2ScrollStateResult = await safeCallTool(client, 'neko_get_state', {});
    const scrollListLinkIndex = findElementIndexByHrefSuffix(p2ScrollStateResult.text, '#itemLink');
    const scrollIntoViewTargetIndex = findElementIndexByHrefSuffix(p2ScrollStateResult.text, '#farLink');
    if (scrollListLinkIndex === null) {
      console.error('[WARN] scrollListLinkのindex取得に失敗した。scroll(container)検証はリンク未検出としてFAILする');
    }
    if (scrollIntoViewTargetIndex === null) {
      console.error('[WARN] scrollIntoViewTargetのindex取得に失敗した。scroll_into_view検証はリンク未検出としてFAILする');
    }

    // === 検証: neko_scroll に index+amount_px を渡すと(container)とscrollTop=を含むこと ===
    let scrollContainerResult = { threw: true, text: 'Error: scrollListLinkIndex is null' };
    if (scrollListLinkIndex !== null) {
      scrollContainerResult = await safeCallTool(client, 'neko_scroll', {
        direction: 'down',
        index: scrollListLinkIndex,
        amount_px: 100,
      });
    }
    record(
      'neko_scroll に index+amount_px を渡すと(container)とscrollTop=を含む',
      !scrollContainerResult.threw &&
        scrollContainerResult.text.includes('(container)') &&
        scrollContainerResult.text.includes('scrollTop='),
      scrollContainerResult.text.slice(0, 150).replace(/\n/g, ' '),
    );

    // === 検証: neko_scroll_into_view でviewport外の要素をスクロールするとin_viewport=trueを含むこと ===
    let scrollIntoViewResult = { threw: true, text: 'Error: scrollIntoViewTargetIndex is null' };
    if (scrollIntoViewTargetIndex !== null) {
      scrollIntoViewResult = await safeCallTool(client, 'neko_scroll_into_view', {
        index: scrollIntoViewTargetIndex,
      });
    }
    record(
      'neko_scroll_into_view でviewport外要素をスクロールするとin_viewport=trueを含む',
      !scrollIntoViewResult.threw && scrollIntoViewResult.text.includes('in_viewport=true'),
      scrollIntoViewResult.text.slice(0, 150).replace(/\n/g, ' '),
    );

    // --- /p2へ遷移(検証対象外の準備動作) ---
    await safeCallTool(client, 'neko_navigate', { url: `${baseUrl}/p2` });
    const p2StateResult = await safeCallTool(client, 'neko_get_state', {});
    const btnShareIndex = findElementIndexById(p2StateResult.text, 'btnShare');
    const valueInputIndex = findElementIndexById(p2StateResult.text, 'valueInput');
    const clipInputIndex = findElementIndexById(p2StateResult.text, 'clipInput');
    const dialogBtnIndex = findElementIndexById(p2StateResult.text, 'dialogBtn');
    if (btnShareIndex === null) {
      console.error('[WARN] btnShareのindex取得に失敗した(id属性未実装の可能性)。id/css条件検証・screenshot mask検証はFAILする');
    }
    if (valueInputIndex === null) {
      console.error('[WARN] valueInputのindex取得に失敗した。fill/get_value検証はFAILする');
    }
    if (clipInputIndex === null) {
      console.error('[WARN] clipInputのindex取得に失敗した。clipboard検証はFAILする');
    }
    if (dialogBtnIndex === null) {
      console.error('[WARN] dialogBtnのindex取得に失敗した。handle_dialog検証はFAILする');
    }

    // === 検証: neko_find_elements の id 引数で btnShare のみ取得できる(キャンセルボタンは含まない) ===
    // cancelBtnをページに置いているのは、id引数が未実装で無視され全件返しになった場合に
    // "キャンセル"という文言も出力へ混入させ、意図せずPASSする事故を防ぐため
    const findByIdResult = await safeCallTool(client, 'neko_find_elements', { id: 'btnShare' });
    record(
      'neko_find_elements の id 引数で btnShare(共有ボタン)のみ取得できる(キャンセルボタンは含まない)',
      !findByIdResult.threw &&
        !findByIdResult.text.startsWith('Error:') &&
        findByIdResult.text.includes('共有') &&
        !findByIdResult.text.includes('キャンセル'),
      findByIdResult.text.slice(0, 150).replace(/\n/g, ' '),
    );

    // === 検証: neko_find_elements の css 引数(#btnShare) で同様にbtnShareのみ取得できる ===
    const findByCssResult = await safeCallTool(client, 'neko_find_elements', { css: '#btnShare' });
    record(
      'neko_find_elements の css 引数(#btnShare) で同じ要素のみ取得できる(キャンセルボタンは含まない)',
      !findByCssResult.threw &&
        !findByCssResult.text.startsWith('Error:') &&
        findByCssResult.text.includes('共有') &&
        !findByCssResult.text.includes('キャンセル'),
      findByCssResult.text.slice(0, 150).replace(/\n/g, ' '),
    );

    // === 検証: neko_fill でinput要素に値を入れると出力が"with value:"を含むこと ===
    let fillResult = { threw: true, text: 'Error: valueInputIndex is null' };
    if (valueInputIndex !== null) {
      fillResult = await safeCallTool(client, 'neko_fill', {
        index: valueInputIndex,
        text: '猫の新しい値テスト',
      });
    }
    record(
      'neko_fill でinput要素に値を入れると出力が"with value:"を含む',
      !fillResult.threw && fillResult.text.includes('with value:'),
      fillResult.text.slice(0, 150).replace(/\n/g, ' '),
    );

    // === 検証: neko_get_value がfill後の実値を返し、HTML初期値(initial-value)と異なること ===
    // (契約書指示: HTML属性の初期値と違う値を入れて差を見る)
    let getValueResult = { threw: true, text: 'Error: valueInputIndex is null' };
    if (valueInputIndex !== null) {
      getValueResult = await safeCallTool(client, 'neko_get_value', { index: valueInputIndex });
    }
    record(
      'neko_get_value がfill後の実値(猫の新しい値テスト)を返しHTML初期値(initial-value)と異なる',
      !getValueResult.threw &&
        getValueResult.text.includes('猫の新しい値テスト') &&
        !getValueResult.text.includes('initial-value'),
      getValueResult.text.slice(0, 150).replace(/\n/g, ' '),
    );

    // === 検証: neko_clipboard で日本語をwrite→paste後、neko_get_valueで化けずに取得できること ===
    const clipboardText = 'クリップボード確認猫';
    let clipboardOk = false;
    let clipboardDetail = 'clipInputIndex is null';
    if (clipInputIndex !== null) {
      const clipWriteResult = await safeCallTool(client, 'neko_clipboard', {
        action: 'write',
        text: clipboardText,
      });
      const clipClickResult = await safeCallTool(client, 'neko_click', { index: clipInputIndex });
      const clipPasteResult = await safeCallTool(client, 'neko_clipboard', { action: 'paste' });
      const clipGetValueResult = await safeCallTool(client, 'neko_get_value', { index: clipInputIndex });
      clipboardOk =
        !clipWriteResult.threw &&
        !clipClickResult.threw &&
        !clipPasteResult.threw &&
        !clipGetValueResult.threw &&
        clipGetValueResult.text.includes(clipboardText);
      clipboardDetail = `write_threw=${clipWriteResult.threw} paste_threw=${clipPasteResult.threw} get_value=${clipGetValueResult.text.slice(0, 80).replace(/\n/g, ' ')}`;
    }
    record(
      'neko_clipboard で日本語をwrite→paste後、neko_get_valueで化けずに取得できる',
      clipboardOk,
      clipboardDetail,
    );

    // === 検証: neko_upload_file がiframe内のinput[type=file]にindex指定で投入できること ===
    // (design-p2-contract.md機能6: 効かない場合はFAILでよい。それ自体が判断材料になる)
    const p2UploadFrameStateResult = await safeCallTool(client, 'neko_get_state', {});
    const frameFileInputIndex = findElementIndexById(p2UploadFrameStateResult.text, 'frameFileInput');
    let uploadFileResult = { threw: true, text: 'Error: frameFileInputIndex is null' };
    if (frameFileInputIndex !== null) {
      uploadFileResult = await safeCallTool(client, 'neko_upload_file', {
        index: frameFileInputIndex,
        file_paths: [tmpUploadFilePath],
      });
    }
    record(
      'neko_upload_file がiframe内のinput[type=file]にindex指定で投入できる',
      !uploadFileResult.threw && !uploadFileResult.text.startsWith('Error:'),
      `frameFileInputIndex=${frameFileInputIndex} ${uploadFileResult.text.slice(0, 100).replace(/\n/g, ' ')}`,
    );

    // === 検証: neko_screenshot に mask_indexes を渡すとキャプションが"masked="を含むこと ===
    let maskedScreenshotResult = { threw: true, text: 'Error: btnShareIndex is null' };
    if (btnShareIndex !== null) {
      maskedScreenshotResult = await safeCallTool(client, 'neko_screenshot', {
        mask_indexes: [btnShareIndex],
      });
    }
    record(
      'neko_screenshot に mask_indexes を渡すとキャプションが"masked="を含む',
      !maskedScreenshotResult.threw && maskedScreenshotResult.text.includes('masked='),
      maskedScreenshotResult.text.slice(0, 150).replace(/\n/g, ' '),
    );

    // === 検証: neko_screenshot を引数なしで呼ぶとキャプションが"fullPage="を含むこと(回帰確認) ===
    const plainScreenshotResult = await safeCallTool(client, 'neko_screenshot', {});
    record(
      'neko_screenshot を引数なしで呼ぶとキャプションが"fullPage="を含む(既存ツール回帰確認)',
      !plainScreenshotResult.threw && plainScreenshotResult.text.includes('fullPage='),
      plainScreenshotResult.text.slice(0, 150).replace(/\n/g, ' '),
    );

    // === 検証: neko_handle_dialog に once:true を渡すと1回だけacceptし、2回目は既定のdismissに戻ること ===
    // dialogBtnはconfirm()の戻り値をdialogResultへ書き込む(alertは戻り値が無くaccept/dismissの
    // 違いを観測できないため、confirm()を使ったページ設計にしている)
    let dialogOk = false;
    let dialogDetail = 'dialogBtnIndex is null';
    if (dialogBtnIndex !== null) {
      const setOnceResult = await safeCallTool(client, 'neko_handle_dialog', {
        action: 'accept',
        once: true,
      });
      const firstClickResult = await safeCallTool(client, 'neko_click', { index: dialogBtnIndex });
      const firstResultResult = await safeCallTool(client, 'neko_get_text', {});
      const firstAccepted = firstResultResult.text.includes('accepted');
      const secondClickResult = await safeCallTool(client, 'neko_click', { index: dialogBtnIndex });
      const secondResultResult = await safeCallTool(client, 'neko_get_text', {});
      const secondDismissed = secondResultResult.text.includes('dismissed');
      dialogOk =
        !setOnceResult.threw &&
        !firstClickResult.threw &&
        !secondClickResult.threw &&
        firstAccepted &&
        secondDismissed;
      dialogDetail = `set_once=${setOnceResult.text.slice(0, 80).replace(/\n/g, ' ')} first_accepted=${firstAccepted} second_dismissed=${secondDismissed}`;
    }
    record(
      'neko_handle_dialog の once:true は1回だけacceptし2回目は既定のdismissに戻る',
      dialogOk,
      dialogDetail,
    );

    // --- /p2-dragへ遷移(検証対象外の準備動作) ---
    await safeCallTool(client, 'neko_navigate', { url: `${baseUrl}/p2-drag` });
    const p2DragStateResult = await safeCallTool(client, 'neko_get_state', {});
    const dragItemAIndex = findElementIndexById(p2DragStateResult.text, 'dragItemA');
    const dragItemCIndex = findElementIndexById(p2DragStateResult.text, 'dragItemC');
    if (dragItemAIndex === null || dragItemCIndex === null) {
      console.error(
        `[WARN] drag対象要素のindex取得に失敗した(A=${dragItemAIndex}, C=${dragItemCIndex})。drag検証はFAILする`,
      );
    }

    // === 検証: neko_drag でItem AをItem Cへドラッグすると並び順が変わること(DOM順序で確認) ===
    let dragOk = false;
    let dragDetail = 'dragItemAIndex or dragItemCIndex is null';
    if (dragItemAIndex !== null && dragItemCIndex !== null) {
      const dragResult = await safeCallTool(client, 'neko_drag', {
        index_from: dragItemAIndex,
        index_to: dragItemCIndex,
      });
      const afterDragTextResult = await safeCallTool(client, 'neko_get_text', {});
      const posA = afterDragTextResult.text.indexOf('Item A');
      const posB = afterDragTextResult.text.indexOf('Item B');
      const orderChanged = posA !== -1 && posB !== -1 && posB < posA;
      dragOk = !dragResult.threw && orderChanged;
      dragDetail = `drag_threw=${dragResult.threw} posA=${posA} posB=${posB} ${dragResult.text.slice(0, 80).replace(/\n/g, ' ')}`;
    }
    record(
      'neko_drag でItem AをItem Cへドラッグすると並び順が変わる(Item BがItem Aより先に出現)',
      dragOk,
      dragDetail,
    );
    // === P2検証(第2弾)ここまで ====================================================
  } finally {
    // --- 後片付け: neko_close(ブラウザ)→MCPクライアント(→子プロセス)→HTTPサーバ→一時プロファイルの順 ---
    if (client) {
      // context.close()の完了を待ってからclient.close()することで、
      // StdioClientTransportのSIGTERM猶予(2秒)頼みにせずChromiumの正常終了を確実にする
      const closeToolResult = await safeCallTool(client, 'neko_close', {});
      if (closeToolResult.threw) {
        console.error(`[WARN] neko_close呼び出し時に例外: ${closeToolResult.text}`);
      } else {
        console.log(`[INFO] neko_close完了: ${closeToolResult.text}`);
      }
      await client.close().catch((err) => {
        console.error(`[WARN] MCPクライアントclose時にエラー: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    if (httpServer) {
      await new Promise((resolve) => httpServer.close(() => resolve(undefined)));
    }
    // 一時ディレクトリがos.tmpdir()配下であることを確認してから削除する(誤削除防止の安全弁)
    const tmpRoot = path.resolve(os.tmpdir());
    const resolvedProfile = path.resolve(tmpProfileDir);
    if (resolvedProfile === tmpRoot || resolvedProfile.startsWith(tmpRoot + path.sep)) {
      try {
        // neko_closeでbrowserContextを閉じた後でも、Windowsではプロファイル内
        // ファイルのロック解放にわずかに遅延が生じることがある(実測でEPERMを確認済み)。
        // EBUSY/EPERM/ENOTEMPTY等はNode標準のリトライ機構に任せる(300ms間隔・最大10回)
        fs.rmSync(resolvedProfile, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 300,
        });
        console.log(`[INFO] 一時プロファイルを削除した: ${resolvedProfile}`);
      } catch (err) {
        // 削除失敗はテスト結果の判定(checks)には影響させず、事実として警告に残す
        console.error(
          `[WARN] 一時プロファイルの削除に失敗した(残存の可能性あり): ${resolvedProfile} — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } else {
      console.error(`[WARN] 一時プロファイルがos.tmpdir()配下と確認できないため削除をスキップした: ${resolvedProfile}`);
    }

    // P1-6検証用の一時ダウンロードディレクトリも同じ安全弁+リトライで削除する
    const resolvedDownloadDir = path.resolve(tmpDownloadDir);
    if (resolvedDownloadDir === tmpRoot || resolvedDownloadDir.startsWith(tmpRoot + path.sep)) {
      try {
        // プロファイル削除と同じ理由(Windowsでのロック解放遅延)でリトライ機構に任せる
        fs.rmSync(resolvedDownloadDir, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 300,
        });
        console.log(`[INFO] 一時ダウンロードディレクトリを削除した: ${resolvedDownloadDir}`);
      } catch (err) {
        console.error(
          `[WARN] 一時ダウンロードディレクトリの削除に失敗した(残存の可能性あり): ${resolvedDownloadDir} — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } else {
      console.error(
        `[WARN] 一時ダウンロードディレクトリがos.tmpdir()配下と確認できないため削除をスキップした: ${resolvedDownloadDir}`,
      );
    }

    // P2検証用の一時アップロードディレクトリも同じ安全弁+リトライで削除する
    const resolvedUploadDir = path.resolve(tmpUploadDir);
    if (resolvedUploadDir === tmpRoot || resolvedUploadDir.startsWith(tmpRoot + path.sep)) {
      try {
        fs.rmSync(resolvedUploadDir, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 300,
        });
        console.log(`[INFO] 一時アップロードディレクトリを削除した: ${resolvedUploadDir}`);
      } catch (err) {
        console.error(
          `[WARN] 一時アップロードディレクトリの削除に失敗した(残存の可能性あり): ${resolvedUploadDir} — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } else {
      console.error(
        `[WARN] 一時アップロードディレクトリがos.tmpdir()配下と確認できないため削除をスキップした: ${resolvedUploadDir}`,
      );
    }
  }
}

// --- エントリポイント: 全体タイムアウト付きでmain()を実行し、結果をexit codeへ反映する ---
async function run() {
  try {
    await withTimeout(main(), TIMEOUT_MS, '全体処理');
  } catch (err) {
    console.error(`[FATAL] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    // タイムアウト等でmain()内のfinally(後片付け)がまだ完了していない可能性があるため、
    // 猶予時間を与えたうえで、それでも生存していれば強制終了する(ハング時も非ゼロ終了させる)
    setTimeout(() => {
      console.error('[WARN] 後片付けの猶予後もプロセスが残存したため強制終了する');
      process.exit(1);
    }, FORCE_EXIT_GRACE_MS).unref();
    return;
  }

  // --- 実行数の整合性チェック: 想定件数と食い違えば「未実行の項目がある」としてFAILにする ---
  if (checks.length !== EXPECTED_CHECK_COUNT) {
    console.error(
      `[FATAL] 検証項目の実行数(${checks.length})が期待値(${EXPECTED_CHECK_COUNT})と一致しない`,
    );
    process.exitCode = 1;
    return;
  }

  const failed = checks.filter((c) => !c.ok);
  console.log('--------------------------------------------------------------');
  console.log(`合計 ${checks.length} 項目 / PASS ${checks.length - failed.length} / FAIL ${failed.length}`);
  if (failed.length > 0) {
    console.log('FAILした項目:');
    for (const f of failed) {
      console.log(`  - ${f.name}`);
    }
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
}

run();
