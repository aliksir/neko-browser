// -----------------------------------------------------------------------------
// 猫ブラウザ e2e stdio 試験（状態取得・待機・evaluate の応答）
// -----------------------------------------------------------------------------
// 目的: dist/index.js を子プロセスとして起動し、MCP クライアントから stdio 経由で
//       次の4点を実機（ヘッドレス Chromium）で確かめる。
//       (a) 要素数の上限で打ち切ったときの truncated / total_candidates / ヒント
//       (b) neko_wait_for の dom_stable_ms（DOM の変化が止まるのを待つ）
//       (c) neko_evaluate のページ側例外とツール自体の失敗の区別（isError）
//       (d) neko_get_state の信頼できないデータの印
//       あわせて、既存の既定の呼び方の応答が変更前と同じかを比べる（negative check）。
// 実行:
//   node tests/e2e-state-wait-evaluate-smoke.mjs --record <file>   変更前の応答を記録する
//   node tests/e2e-state-wait-evaluate-smoke.mjs --compare <file>  記録と比べ、4点を検証する
//   exit 0 = 全項目 PASS / exit 1 = いずれか FAIL または異常終了
// 注意: ビルドは行わない。外部サイトには接続しない（127.0.0.1 のローカルサーバだけを使う）。
//       プロファイル・ダウンロード先は os.tmpdir() 配下の一時ディレクトリだけを使う。
// -----------------------------------------------------------------------------

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ここからパスと引数の解釈
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_INDEX = path.join(REPO_ROOT, 'dist', 'index.js');
const mode = process.argv[2];
const dataFile = process.argv[3];
if ((mode !== '--record' && mode !== '--compare') || !dataFile) {
  console.error('usage: node tests/e2e-state-wait-evaluate-smoke.mjs --record|--compare <file>');
  process.exit(1);
}
// ハングしても必ず終わらせるための全体上限(ms)
const TIMEOUT_MS = 180000;

// ここから試験用ページ（ローカル HTML）の定義
const PAGES = {
  // 要素が少ないページ（打ち切りが起きない）
  '/few': '<title>few</title><button>一</button><button>二</button><a href="#x">リンク</a><input placeholder="入力">',
  // 要素が 350 件あるページ（既定上限 300 を超える）
  '/many':
    '<title>many</title>' +
    Array.from({ length: 350 }, (_, i) => `<button>btn ${i}</button>`).join(''),
  // 50ms ごとに 30 回 DOM を書き換え、その後は止まるページ
  '/mutating':
    '<title>mutating</title><div id="box"></div><script>' +
    'window.__done=false;let n=0;const iv=setInterval(()=>{' +
    'const d=document.createElement("div");d.textContent="m"+n;document.getElementById("box").appendChild(d);n++;' +
    'if(n>=30){clearInterval(iv);window.__done=true;}},50);</script>',
  // 50ms ごとに DOM を書き換え続けて止まらないページ
  '/forever':
    '<title>forever</title><div id="box"></div><script>' +
    'let n=0;setInterval(()=>{document.getElementById("box").textContent="tick"+(n++);},50);</script>',
  // evaluate 用の素のページ
  '/plain': '<title>plain</title><p>plain</p>',
};

// ローカル HTTP サーバを 127.0.0.1 の空きポートで起動する
function startLocalServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = PAGES[req.url ?? ''];
      if (body === undefined) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// 子プロセス用の環境変数を組み立てる（常駐用の設定を持ち込まないよう evaluate 系の変数は消してから必要分だけ足す）
function buildChildEnv(profileDir, downloadDir, enableEvaluate) {
  const env = { ...process.env };
  // NEKO_ で始まる変数（常駐用のゲート・ラベル・窓位置など）はすべて外す
  for (const key of Object.keys(env)) {
    if (key.startsWith('NEKO_')) delete env[key];
  }
  env.NEKO_BROWSER_HEADLESS = 'true';
  env.NEKO_BROWSER_PROFILE = profileDir;
  env.NEKO_BROWSER_DOWNLOAD_DIR = downloadDir;
  if (enableEvaluate) env.NEKO_BROWSER_ENABLE_EVALUATE = 'true';
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return env;
}

// MCP サーバ（dist/index.js）を1つ起動して接続する
async function connect(profileDir, downloadDir, enableEvaluate) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_INDEX],
    cwd: REPO_ROOT,
    env: buildChildEnv(profileDir, downloadDir, enableEvaluate),
    stderr: 'ignore',
  });
  const client = new Client({ name: 'e2e-state-wait-evaluate', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

// ツールを呼び、先頭の text と isError をまとめて返す
async function call(client, name, args = {}) {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args });
  const textItem = (result.content ?? []).find((c) => c && c.type === 'text');
  return {
    text: textItem ? String(textItem.text ?? '') : '',
    isError: result.isError === true,
    elapsedMs: Date.now() - started,
  };
}

// 実行ごとに変わるローカルサーバの URL（ポート）を固定の文字列に置き換える
function normalizeText(text, base) {
  return text.split(base).join('http://BASE');
}

// get_state の JSON から実行ごとに変わる値（一時プロファイルのパス・ポート・タブID）を取り除く
function normalizeState(text, base) {
  const obj = JSON.parse(normalizeText(text, base));
  delete obj.profile_dir;
  obj.tabs = (obj.tabs ?? []).map((t) => ({ ...t, tab_id: '<id>' }));
  return obj;
}

// 今回追加したキーを取り除く（negative check で「追加分以外は同じ」を比べるため）
const ADDED_STATE_KEYS = ['untrusted_notice', 'truncated', 'total_candidates', 'truncation_hint'];
function stripAdded(obj) {
  const copy = { ...obj };
  for (const key of ADDED_STATE_KEYS) delete copy[key];
  return copy;
}

// 結果の記録（PASS/FAIL を1行ずつ出す）
const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
    console.log(`[PASS] ${name}`);
  } catch (err) {
    checks.push({ name, ok: false });
    console.log(`[FAIL] ${name} — ${err instanceof Error ? err.message.split('\n')[0] : err}`);
  }
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-browser-e2e-swe-'));
  const dirs = ['profile-a', 'profile-b', 'dl-a', 'dl-b'].map((d) => {
    const p = path.join(tmpRoot, d);
    fs.mkdirSync(p);
    return p;
  });
  const httpServer = await startLocalServer();
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const clients = [];
  // 比較時にポートを正規化できるよう、使った URL も記録する
  const observed = { __base: base };

  try {
    // ここからサーバ A（evaluate 有効）での観測
    const a = await connect(dirs[0], dirs[2], true);
    clients.push(a);

    await call(a, 'neko_navigate', { url: `${base}/few` });
    observed.few_get_state = await call(a, 'neko_get_state', {});
    observed.few_snapshot = await call(a, 'neko_snapshot', {});
    observed.few_find = await call(a, 'neko_find_elements', {});
    observed.wait_load = await call(a, 'neko_wait_for', { load_state: 'load' });

    await call(a, 'neko_navigate', { url: `${base}/many` });
    observed.many_get_state = await call(a, 'neko_get_state', {});
    observed.many_get_state_400 = await call(a, 'neko_get_state', { max_elements: 400 });
    observed.many_snapshot = await call(a, 'neko_snapshot', {});
    observed.many_find = await call(a, 'neko_find_elements', { text: 'btn 1' });

    await call(a, 'neko_navigate', { url: `${base}/plain` });
    observed.eval_sum = await call(a, 'neko_evaluate', { expression: '1 + 2' });
    observed.eval_title = await call(a, 'neko_evaluate', { expression: 'document.title' });
    observed.eval_obj = await call(a, 'neko_evaluate', { expression: '({ a: 1, b: [2, 3] })' });
    observed.eval_undef = await call(a, 'neko_evaluate', { expression: 'void 0' });
    observed.eval_fn_arg = await call(a, 'neko_evaluate', { expression: '(x) => x * 2', arg: 21 });
    observed.eval_throw = await call(a, 'neko_evaluate', { expression: 'throw new TypeError("boom")' });
    observed.eval_reject = await call(a, 'neko_evaluate', {
      expression: 'Promise.reject(new RangeError("late boom"))',
    });
    observed.eval_throw_string = await call(a, 'neko_evaluate', { expression: '(() => { throw "plain string"; })()' });
    observed.eval_empty = await call(a, 'neko_evaluate', { expression: '' });
    // 評価中に遷移させて実行文脈を消す（Playwright 側の失敗＝ツール側の失敗として分類されるか）
    observed.eval_navigate_away = await call(a, 'neko_evaluate', {
      expression: 'location.href = "/few"; new Promise(() => {})',
    });

    await call(a, 'neko_navigate', { url: `${base}/mutating` });
    observed.wait_stable_ok = await call(a, 'neko_wait_for', { dom_stable_ms: 400, timeout: 8000 });
    observed.wait_stable_done_flag = await call(a, 'neko_evaluate', { expression: 'window.__done' });

    await call(a, 'neko_navigate', { url: `${base}/forever` });
    observed.wait_stable_timeout = await call(a, 'neko_wait_for', { dom_stable_ms: 400, timeout: 2000 });

    // ブラウザを閉じた後の evaluate（ツール自体の失敗）
    await call(a, 'neko_close', {});
    observed.eval_after_close = await call(a, 'neko_evaluate', { expression: '1 + 2' });

    // ここからサーバ B（evaluate 無効＝既定）での観測
    const b = await connect(dirs[1], dirs[3], false);
    clients.push(b);
    await call(b, 'neko_navigate', { url: `${base}/plain` });
    observed.eval_gate = await call(b, 'neko_evaluate', { expression: '1 + 2' });
    observed.wait_js_gate = await call(b, 'neko_wait_for', { js_condition: 'true' });
  } finally {
    for (const c of clients) await c.close().catch(() => undefined);
    httpServer.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  // 記録モード: 観測結果をそのまま保存して終わる
  if (mode === '--record') {
    fs.writeFileSync(dataFile, JSON.stringify(observed, null, 2), 'utf-8');
    console.log(`[INFO] recorded ${Object.keys(observed).length} responses to ${dataFile}`);
    return 0;
  }

  // ここから比較モードの判定
  fs.writeFileSync(dataFile.replace(/\.json$/, '') + '.after.json', JSON.stringify(observed, null, 2), 'utf-8');
  const before = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
  const o = observed;
  const nb = (x) => normalizeText(x, before.__base);
  const na = (x) => normalizeText(x, o.__base);

  // (a) 打ち切り
  const manyState = JSON.parse(o.many_get_state.text);
  check('(a) 350件ページの get_state に truncated:true と総数 350 が入る', () => {
    assert.equal(manyState.truncated, true);
    assert.equal(manyState.total_candidates, 350);
    assert.equal(manyState.interactive_elements.length, 300);
    assert.match(manyState.truncation_hint, /max_elements/);
  });
  check('(a) max_elements:400 なら truncated キーは付かない', () => {
    const s = JSON.parse(o.many_get_state_400.text);
    assert.equal(s.interactive_elements.length, 350);
    assert.equal('truncated' in s, false);
  });
  check('(a) 少ないページの get_state に truncated キーは付かない', () => {
    const s = JSON.parse(o.few_get_state.text);
    assert.equal('truncated' in s, false);
    assert.equal('total_candidates' in s, false);
  });
  check('(a) 350件ページの snapshot に打ち切り行が入る', () => {
    assert.match(o.many_snapshot.text, /^truncated: true \(analyzed 300 of 350 candidates, viewport first\)\. Raise max_elements/m);
  });
  check('(a) 350件ページの find_elements に truncated と総数が入る', () => {
    const f = JSON.parse(o.many_find.text);
    assert.equal(f.truncated, true);
    assert.equal(f.total_candidates, 350);
  });

  // (b) DOM の安定待ち
  check('(b) 書き換えが止まるページで dom_stable_ms が成功する', () => {
    assert.equal(o.wait_stable_ok.isError, false);
    assert.match(o.wait_stable_ok.text, /^DOM stable/);
  });
  check('(b) 成功は書き換えの終了後（window.__done が true）', () => {
    assert.equal(o.wait_stable_done_flag.text, 'true');
    // 30回×50ms の書き換え + 静止 400ms より早く返っていないこと
    assert.ok(o.wait_stable_ok.elapsedMs >= 1500, `elapsed=${o.wait_stable_ok.elapsedMs}`);
  });
  check('(b) 書き換えが止まらないページでは timeout で失敗する', () => {
    assert.match(o.wait_stable_timeout.text, /^Error: DOM did not become stable/);
    assert.ok(o.wait_stable_timeout.elapsedMs >= 2000, `elapsed=${o.wait_stable_timeout.elapsedMs}`);
  });

  // (c) evaluate の区別
  check('(c) ページ側の throw は isError なしで PAGE_EXCEPTION と種別・message が返る', () => {
    assert.equal(o.eval_throw.isError, false);
    assert.match(o.eval_throw.text, /^PAGE_EXCEPTION/);
    assert.match(o.eval_throw.text, /^name: TypeError$/m);
    assert.match(o.eval_throw.text, /^message: boom$/m);
  });
  check('(c) Promise の reject もページ側例外として返る', () => {
    assert.equal(o.eval_reject.isError, false);
    assert.match(o.eval_reject.text, /^name: RangeError$/m);
  });
  check('(c) ゲート禁止は isError が立つ（本文は従来どおり）', () => {
    assert.equal(o.eval_gate.isError, true);
    assert.equal(o.eval_gate.text, before.eval_gate.text);
  });
  check('(c) ブラウザを閉じた後の evaluate は isError が立つ', () => {
    assert.equal(o.eval_after_close.isError, true);
    assert.match(o.eval_after_close.text, /^Error: /);
  });
  check('(c) 評価中の遷移で実行文脈が消えた場合は isError が立つ', () => {
    assert.equal(o.eval_navigate_away.isError, true);
    assert.match(o.eval_navigate_away.text, /^Error: /);
  });
  check('(c) expression 未指定は isError が立つ', () => {
    assert.equal(o.eval_empty.isError, true);
    assert.equal(o.eval_empty.text, before.eval_empty.text);
  });

  // (d) 信頼できないデータの印
  check('(d) get_state に UNTRUSTED の印が入る', () => {
    const s = JSON.parse(o.few_get_state.text);
    assert.match(s.untrusted_notice, /UNTRUSTED PAGE DATA/);
    assert.match(s.untrusted_notice, /not instructions/);
  });

  // negative check: 既定の呼び方の応答が変更前と同じ
  check('(neg) 引数なし get_state は追加キー以外が変更前と同じ', () => {
    assert.deepEqual(stripAdded(normalizeState(o.few_get_state.text, o.__base)), normalizeState(before.few_get_state.text, before.__base));
  });
  check('(neg) 350件ページの get_state も要素一覧は変更前と同じ', () => {
    assert.deepEqual(stripAdded(normalizeState(o.many_get_state.text, o.__base)), normalizeState(before.many_get_state.text, before.__base));
  });
  check('(neg) 少ないページの snapshot / find_elements は変更前と同じ', () => {
    assert.equal(na(o.few_snapshot.text), nb(before.few_snapshot.text));
    assert.equal(na(o.few_find.text), nb(before.few_find.text));
  });
  check('(neg) load_state だけの wait_for は変更前と同じ', () => {
    assert.equal(o.wait_load.text, before.wait_load.text);
    assert.equal(o.wait_load.isError, before.wait_load.isError);
  });
  check('(neg) 正常な evaluate 5種は変更前と同じ', () => {
    for (const key of ['eval_sum', 'eval_title', 'eval_obj', 'eval_undef', 'eval_fn_arg']) {
      assert.equal(o[key].text, before[key].text, key);
      assert.equal(o[key].isError, false, key);
    }
  });
  check('(neg) js_condition のゲート応答は変更前と同じ', () => {
    assert.equal(o.wait_js_gate.text, before.wait_js_gate.text);
    assert.equal(o.wait_js_gate.isError, before.wait_js_gate.isError);
  });

  const failed = checks.filter((c) => !c.ok).length;
  console.log(`[SUMMARY] ${checks.length - failed}/${checks.length} PASS`);
  return failed === 0 ? 0 : 1;
}

// 全体タイムアウト付きで実行する
const timer = setTimeout(() => {
  console.error(`[FATAL] ${TIMEOUT_MS}ms でタイムアウトした`);
  process.exit(1);
}, TIMEOUT_MS);
main()
  .then((code) => {
    clearTimeout(timer);
    process.exit(code);
  })
  .catch((err) => {
    clearTimeout(timer);
    console.error('[FATAL]', err);
    process.exit(1);
  });
