// 猫ブラウザ 第2弾 単体テスト Part1（担当: 機能1/2/3/5/9）
// 対象: neko_scroll拡張 + neko_scroll_into_view新設 / neko_screenshot拡張 / id・css条件指定 / neko_get_value新設 / neko_fill自動振り分け
// 契約書: design-p2-contract.md（仕事猫確定版）の出力文字列を厳密にassertする。契約書に無い文字列は推測で書かない。
// 実装はこのテストと並行して進行中のため、実装前は多くのケースがFAILするのが正しい（陽性コントロール）。落ちても直しに行かない。
// テストの書き方は tests/agent-browser-ext.test.mjs / tests/power-platform-optimization.test.mjs を踏襲する
// （server.currentPage = page を直接代入し、コンパイル後のprivateメソッドを直接呼ぶ方式。外部通信はしない）
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { NekoBrowserServer } from '../dist/server.js';
import { analyzeDom } from '../dist/dom-analyzer.js';

let browser;
let page;
let server;

// ---------------------------------------------------------------------
// テスト共通ヘルパー
// ---------------------------------------------------------------------

/** analyzeDomを実行し、セレクタに一致する要素に付与されたdata-mcp-index値を取得する（複数要素混在時の確実な対応付け用） */
async function indexOf(pg, selector) {
  await analyzeDom(pg);
  const attr = await pg.locator(selector).first().getAttribute('data-mcp-index');
  assert.notEqual(
    attr,
    null,
    `セレクタ ${selector} にdata-mcp-index属性が付与されていない（インタラクティブ要素として認識されているか確認）`,
  );
  return Number(attr);
}

/** viewportSize()がnullを返すケース（viewport:null設定時）に備え、ブラウザ内JSでフォールバック取得する */
async function getViewportSize(pg) {
  return (
    pg.viewportSize() ??
    (await pg.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })))
  );
}

/**
 * base64エンコードされたPNGを別ページのimg要素にロードし、evaluateFnで解析結果を取り出す共通処理。
 * PNGデコーダを自作せず、ブラウザ標準のimgデコード機能とcanvas.getImageDataだけを使う（新規npm依存を足さない）。
 */
async function withDecodedPng(evaluateFn, base64, evaluateArg) {
  const probePage = await browser.newPage();
  try {
    await probePage.setContent('<img id="probe"><canvas id="cv"></canvas>');
    await probePage.evaluate((b64) => {
      document.getElementById('probe').src = `data:image/png;base64,${b64}`;
    }, base64);
    // 画像デコード完了（naturalWidthが確定）まで待つ
    await probePage.waitForFunction(() => {
      const img = document.getElementById('probe');
      return img.complete && img.naturalWidth > 0;
    });
    // finally内のprobePage.close()より先にevaluateの結果を待つ必要があるため、returnではなくreturn awaitにする
    // （try節でreturn promiseだけ書くとfinallyがPromise解決前に走り、close済みページへevaluateすることになる）
    return await probePage.evaluate(evaluateFn, evaluateArg);
  } finally {
    await probePage.close();
  }
}

/** PNGの実ピクセルサイズ（幅・高さ）を取得する */
async function getPngSize(base64) {
  return withDecodedPng(() => {
    const img = document.getElementById('probe');
    return { width: img.naturalWidth, height: img.naturalHeight };
  }, base64);
}

/** 画像上の座標(cx, cy)を中心としたsize x sizeピクセルのRGBA配列を取得する（canvas.drawImage + getImageData） */
async function readPixelBlock(base64, cx, cy, size = 10) {
  return withDecodedPng(
    ({ cx, cy, size }) => {
      const img = document.getElementById('probe');
      const canvas = document.getElementById('cv');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const half = Math.floor(size / 2);
      const data = ctx.getImageData(cx - half, cy - half, size, size).data;
      const pixels = [];
      for (let i = 0; i < data.length; i += 4) {
        pixels.push([data[i], data[i + 1], data[i + 2], data[i + 3]]);
      }
      return pixels;
    },
    base64,
    { cx, cy, size },
  );
}

/** ピクセル配列が全て同一RGBかどうか判定する（マスク領域の塗り一様性確認用。色の値そのものはassertしない） */
function isUniformColor(pixels) {
  const [r0, g0, b0] = pixels[0];
  return pixels.every(([r, g, b]) => r === r0 && g === g0 && b === b0);
}

// ---------------------------------------------------------------------

describe('猫ブラウザ第2弾 単体テスト Part1 (機能1/2/3/5/9)', () => {
  before(async () => {
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    await browser?.close();
  });

  beforeEach(async () => {
    page = await browser.newPage();
    server = new NekoBrowserServer();
    server.currentPage = page;
  });

  afterEach(async () => {
    await page?.close();
  });

  // ---------------------------------------------------------------------
  // 機能1: neko_scroll拡張 + neko_scroll_into_view新設
  // ---------------------------------------------------------------------
  describe('機能1: neko_scroll拡張 + neko_scroll_into_view', () => {
    test('正常系: index指定でスクロールコンテナのscrollTopがamount_px分だけ動く', async () => {
      // overflow-y:autoの固定高コンテナ内に要素を置き、そのコンテナ自身がスクロールされることを確認する
      await page.setContent(
        '<div id="container" style="height:100px; overflow-y:auto;">' +
          '<div style="height:1000px;"><button id="target" style="margin-top:500px;">対象</button></div>' +
          '</div>',
      );
      const index = await indexOf(page, '#target');

      const response = await server.nekoScroll({ index, amount_px: 50, direction: 'down' });

      // 出力文字列だけでなく、実際にDOM側のscrollTopが動いたことをpage.evaluateで実測する
      const scrollTop = await page.locator('#container').evaluate((el) => el.scrollTop);
      assert.equal(scrollTop, 50, 'スクロールコンテナのscrollTopが指定量分動いていない');
      assert.match(
        response.content[0].text,
        /^Scrolled down by 50px \(container\)\. scrollTop=50, scrollLeft=0$/,
        '契約書の出力文字列と一致しない',
      );
    });

    test('境界: indexとselectorの同時指定はエラーになる', async () => {
      // 排他の2引数を同時指定した場合の契約書エラー文言を確認する
      await page.setContent('<button id="target">対象</button>');
      const index = await indexOf(page, '#target');

      const response = await server.nekoScroll({ index, selector: '#target', direction: 'down' });

      assert.match(response.content[0].text, /^Error: Specify either index or selector, not both\.$/);
    });

    test('回帰: index/selector/amount_pxを全省略した呼び出しは現行どおり(80% of viewport)を返す', async () => {
      // 既存挙動（拡張引数なしのwheelスクロール）が変わっていないことを確認する（最重要の回帰確認）
      await page.setContent('<div style="height:3000px;">長いページ</div>');

      const response = await server.nekoScroll({ direction: 'down' });

      assert.match(response.content[0].text, /\(80% of viewport\)/, '既存挙動の文字列が変わっている(回帰)');
    });

    test('scroll_into_view: viewport外の要素がindex指定で表示範囲内に入る', async () => {
      // 大きなスペーサーでボタンをviewport外に配置し、呼び出し後にviewport内へ入ることを確認する
      await page.setContent('<div style="height:2000px;"></div><button id="target">対象</button>');
      const index = await indexOf(page, '#target');
      const viewport = await getViewportSize(page);
      const before = await page.locator('#target').boundingBox();
      assert.ok(before.y >= viewport.height, '前提が崩れている: 対象要素が最初からviewport内にある');

      const response = await server.nekoScrollIntoView({ index });

      const after = await page.locator('#target').boundingBox();
      assert.ok(
        after.y + after.height > 0 && after.y < viewport.height,
        'scroll_into_view後もviewport内に入っていない',
      );
      assert.match(response.content[0].text, /in_viewport=true/);
      assert.match(response.content[0].text, /rect: x=-?\d+, y=-?\d+, width=\d+, height=\d+/);
    });
  });

  // ---------------------------------------------------------------------
  // 機能2: neko_screenshot拡張
  // ---------------------------------------------------------------------
  describe('機能2: neko_screenshot拡張', () => {
    test('正常系: index指定でPNGが要素サイズになりキャプションにelement index=を含む', async () => {
      // 要素だけを撮った画像の実ピクセルサイズが、その要素のboundingBoxとほぼ一致することを確認する
      await page.setContent(
        '<button id="target" style="position:fixed; top:20px; left:20px; width:120px; height:40px;">対象</button>',
      );
      const index = await indexOf(page, '#target');
      const box = await page.locator('#target').boundingBox();

      const response = await server.nekoScreenshot({ index });

      assert.match(response.content[0].text, new RegExp(`element index=${index}`));
      const imagePart = response.content.find((c) => c.type === 'image');
      const { width, height } = await getPngSize(imagePart.data);
      // 丸め誤差2pxまでは許容する
      assert.ok(
        Math.abs(width - Math.round(box.width)) <= 2,
        `画像幅が要素幅と一致しない: got=${width} want~=${box.width}`,
      );
      assert.ok(
        Math.abs(height - Math.round(box.height)) <= 2,
        `画像高さが要素高さと一致しない: got=${height} want~=${box.height}`,
      );
      const viewport = await getViewportSize(page);
      assert.ok(
        width < viewport.width && height < viewport.height,
        '要素スクリーンショットがページ全体より小さくなっていない',
      );
    });

    test('マスク検査: mask_indexes指定領域が一様色になり対照領域と異なる', async () => {
      // マスク対象と対照要素を並べて撮り、マスク領域だけが単色塗りになっていることをピクセルで確認する
      await page.setContent(
        '<div id="masked" tabindex="0" style="position:absolute; top:10px; left:10px; width:100px; height:60px; background:#3366ff;"></div>' +
          '<div id="visible" style="position:absolute; top:200px; left:10px; width:100px; height:60px; background:#33cc33;"></div>',
      );
      const index = await indexOf(page, '#masked');
      const maskedBox = await page.locator('#masked').boundingBox();
      const visibleBox = await page.locator('#visible').boundingBox();

      const response = await server.nekoScreenshot({ mask_indexes: [index] });

      assert.match(response.content[0].text, /, masked=1/, 'キャプションにmasked=1が含まれていない');
      const imagePart = response.content.find((c) => c.type === 'image');
      const maskedPixels = await readPixelBlock(
        imagePart.data,
        Math.round(maskedBox.x + maskedBox.width / 2),
        Math.round(maskedBox.y + maskedBox.height / 2),
      );
      const visiblePixels = await readPixelBlock(
        imagePart.data,
        Math.round(visibleBox.x + visibleBox.width / 2),
        Math.round(visibleBox.y + visibleBox.height / 2),
      );

      // マスク領域は色の値そのものではなく「一様に塗られているか」だけを確認する（Playwright既定色に依存しない）
      assert.ok(isUniformColor(maskedPixels), 'マスク領域が一様色で塗られていない');
      // 対照領域はマスクされていないため、マスク領域の色とは異なるはず
      assert.notDeepStrictEqual(
        maskedPixels[0].slice(0, 3),
        visiblePixels[0].slice(0, 3),
        'マスク領域と対照領域が同色になっている(マスクされていない疑い)',
      );
    });

    test('回帰: 拡張引数なしのキャプションはScreenshot (で始まりfullPage=を含む', async () => {
      // 拡張引数を渡さない既存呼び出しのキャプション文字列が変わっていないことを確認する
      await page.setContent('<div>ページ</div>');

      const response = await server.nekoScreenshot({});

      assert.match(response.content[0].text, /^Screenshot \(/, '既存キャプションの先頭が変わっている(回帰)');
      assert.match(response.content[0].text, /fullPage=/, '既存キャプションのfullPage=表記が変わっている(回帰)');
    });
  });

  // ---------------------------------------------------------------------
  // 機能3: 条件指定APIへのid/css追加
  // ---------------------------------------------------------------------
  describe('機能3: id/cssによる条件指定', () => {
    test('正常系: idの完全一致で1件だけ拾える', async () => {
      // 同名接頭辞を持つ別idと混在させ、完全一致でのみ1件に絞られることを確認する
      await page.setContent('<button id="btnShare">共有</button><button id="btnOther">他</button>');

      const response = await server.nekoFindElements({ id: 'btnShare' });

      const body = JSON.parse(response.content[0].text);
      assert.equal(body.count, 1, 'id完全一致での件数が1件でない');
      assert.equal(body.elements[0].id, 'btnShare');
    });

    test('正常系: cssセレクタでも同じ要素が拾える', async () => {
      // id指定と同じ要素をCSSセレクタ経由でも取得できることを確認する
      await page.setContent('<button id="btnShare">共有</button><button id="btnOther">他</button>');

      const response = await server.nekoFindElements({ css: '#btnShare' });

      const body = JSON.parse(response.content[0].text);
      assert.equal(body.count, 1, 'cssセレクタでの件数が1件でない');
      assert.equal(body.elements[0].id, 'btnShare');
    });

    test('境界: idは大小区別ありのため大文字指定は0件になる', async () => {
      // 契約書「HTMLのidは大小区別ありなのでtoLowerCaseしない」を確認する
      await page.setContent('<button id="btnShare">共有</button>');

      const response = await server.nekoFindElements({ id: 'BTNSHARE' });

      const body = JSON.parse(response.content[0].text);
      assert.equal(body.count, 0, 'idの大小区別が働いていない(toLowerCaseされている疑い)');
    });

    test('境界: cssが複数一致するとnekoClickTargetはambiguousを返す', async () => {
      // 同一クラスの要素を2つ用意し、曖昧エラーに落ちることを確認する
      await page.setContent('<button class="dup">A</button><button class="dup">B</button>');

      const response = await server.nekoClickTarget({ css: '.dup' });

      assert.match(response.content[0].text, /ambiguous/);
    });

    test('境界: 壊れたcssはInvalid CSS selectorを含むエラーになる', async () => {
      // Playwrightのセレクタパースが失敗するcssを渡し、契約書のエラー文言に変換されることを確認する
      await page.setContent('<button id="btnShare">共有</button>');

      const response = await server.nekoFindElements({ css: '>>>bad' });

      assert.match(response.content[0].text, /Invalid CSS selector/);
    });
  });

  // ---------------------------------------------------------------------
  // 機能5: neko_get_value新設
  // ---------------------------------------------------------------------
  describe('機能5: neko_get_value', () => {
    test('正常系: inputは変更後の実値を返す(HTML初期値とは異なることを確認)', async () => {
      // HTML属性の初期値とは別の値に変更し、実値取得であって初期値の読み戻しではないことを確認する
      await page.setContent('<input id="target" value="初期値">');
      const index = await indexOf(page, '#target');
      await page.locator('#target').fill('新しい値123');

      const response = await server.nekoGetValue({ index });

      const text = response.content[0].text;
      assert.match(text, /value: "新しい値123"/, '変更後の実値が返っていない');
      assert.doesNotMatch(text, /初期値/, 'HTML属性の初期値がそのまま返っている(実値取得になっていない)');
    });

    test('正常系: selectのvalue/labelとcheckboxのcheckedを返す', async () => {
      // select要素は選択中optionのvalueとラベルテキストの両方を、checkboxはchecked状態を返すことを確認する
      await page.setContent(
        '<select id="sel"><option value="a">Aラベル</option><option value="b">Bラベル</option></select>' +
          '<input id="chk" type="checkbox">',
      );
      const selIndex = await indexOf(page, '#sel');
      await page.locator('#sel').selectOption('b');
      const selResponse = await server.nekoGetValue({ index: selIndex });
      assert.match(selResponse.content[0].text, /value: "b" label: "Bラベル"/);

      const chkIndex = await indexOf(page, '#chk');
      await page.locator('#chk').check();
      const chkResponse = await server.nekoGetValue({ index: chkIndex });
      assert.match(chkResponse.content[0].text, /checked: true/);
    });

    test('マスク: type=passwordのinputは常に<redacted>を返す', async () => {
      // パスワード欄は値の内容に関わらず常に伏字であることを確認する
      await page.setContent('<input id="pw" type="password">');
      const index = await indexOf(page, '#pw');
      await page.locator('#pw').fill('himitsu123');

      const response = await server.nekoGetValue({ index });

      assert.match(response.content[0].text, /type=password value: <redacted>/);
      assert.doesNotMatch(response.content[0].text, /himitsu123/, 'パスワードの実値が漏れている');
    });

    test('マスク: メールアドレスを含む値は<email>にマスクされる', async () => {
      // maskSensitiveText経由でメールアドレスパターンが<email>に置換されることを確認する
      await page.setContent('<input id="mail" type="text">');
      const index = await indexOf(page, '#mail');
      await page.locator('#mail').fill('yamada@example.com');

      const response = await server.nekoGetValue({ index });

      assert.match(response.content[0].text, /value: "<email>"/);
      assert.doesNotMatch(response.content[0].text, /yamada@example\.com/, 'メールアドレスの実値が漏れている');
    });

    test('対象外: value概念のない要素は(no value property)を返す', async () => {
      // tabindexを付与してanalyzeDomの対象(インタラクティブ要素)にした上で、value非対応タグの応答を確認する
      await page.setContent('<div id="plain" tabindex="0">ただの表示テキスト</div>');
      const index = await indexOf(page, '#plain');

      const response = await server.nekoGetValue({ index });

      assert.match(response.content[0].text, /\(no value property\)/);
    });
  });

  // ---------------------------------------------------------------------
  // 機能9: neko_fillの自動振り分け
  // ---------------------------------------------------------------------
  describe('機能9: neko_fillの自動振り分け', () => {
    test('正常系: input要素はfill経路でDOM実値が入りwith value:を出力する', async () => {
      // input/textareaはPlaywrightのlocator.fill経由になり、DOMのvalueプロパティに実値が入ることを確認する
      await page.setContent('<input id="target">');
      const index = await indexOf(page, '#target');

      const response = await server.nekoFill({ index, text: '新規入力値' });

      const domValue = await page.locator('#target').inputValue();
      assert.equal(domValue, '新規入力値', 'input要素の実値(value)が設定されていない');
      assert.match(response.content[0].text, /with value: "新規入力値"/);
    });

    test('回帰: contentEditableなdivはwith textContent:のまま', async () => {
      // html未指定のcontentEditableは従来のDOM直接設定経路のままであることを確認する
      await page.setContent('<div id="target" contenteditable="true">旧テキスト</div>');
      const index = await indexOf(page, '#target');

      const response = await server.nekoFill({ index, text: '新テキスト' });

      assert.match(
        response.content[0].text,
        /with textContent: "新テキスト"/,
        '既存の出力文字列が変わっている(回帰)',
      );
      assert.equal(await page.locator('#target').textContent(), '新テキスト');
    });

    test('回帰: html:true指定時はwith innerHTML:のまま', async () => {
      // html:true指定は新経路の対象外で、従来のinnerHTML設定経路のままであることを確認する
      await page.setContent('<div id="target" contenteditable="true">旧HTML</div>');
      const index = await indexOf(page, '#target');

      const response = await server.nekoFill({ index, text: '<b>強調</b>', html: true });

      assert.match(response.content[0].text, /with innerHTML: /, '既存の出力文字列が変わっている(回帰)');
    });
  });
});
