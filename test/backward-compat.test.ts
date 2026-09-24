/**
 * 後方互換テスト
 *
 * iframeがないページで従来通り動作し、
 * frame フィールドがundefinedのElementInfoが正しく処理されることを検証する。
 * Playwrightのブラウザ起動が必要なため、CI環境ではスキップする。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { analyzeDom } from '../src/dom-analyzer.js';

const isCI = process.env['CI'] === 'true';

describe.skipIf(isCI)('後方互換テスト（iframe無しページ）', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 30000);

  afterAll(async () => {
    await browser?.close();
  });

  beforeEach(async () => {
    page = await browser.newPage();
  });

  afterEach(async () => {
    await page?.close();
  });

  // iframeなしの単純ページで従来通りインデックス採番されること
  it('iframeがないページで要素が正しく採番される', async () => {
    await page.setContent(`
      <html><body>
        <button>ボタン1</button>
        <a href="/link">リンク</a>
        <input type="text" placeholder="入力欄" />
      </body></html>
    `);

    const result = await analyzeDom(page);

    // 3つのインタラクティブ要素が検出されること
    expect(result.elements.length).toBeGreaterThanOrEqual(3);
    // インデックスが0始まりの連番であること
    const indices = result.elements.map(e => e.index);
    expect(indices[0]).toBe(0);
    expect(indices[1]).toBe(1);
    expect(indices[2]).toBe(2);
  });

  // iframeなしの要素ではframeフィールドがundefinedであること
  it('メインフレーム要素のframeフィールドがundefined', async () => {
    await page.setContent(`
      <html><body>
        <button>テストボタン</button>
      </body></html>
    `);

    const result = await analyzeDom(page);

    // 全要素のframeがundefined（メインフレームのみ）
    for (const el of result.elements) {
      expect(el.frame).toBeUndefined();
    }
  });

  // 空ページでもエラーにならずに空配列が返ること
  it('インタラクティブ要素のない空ページで空配列が返る', async () => {
    await page.setContent(`
      <html><body>
        <p>テキストのみ</p>
        <div>コンテナ</div>
      </body></html>
    `);

    const result = await analyzeDom(page);

    // インタラクティブ要素がないので空配列
    expect(result.elements).toHaveLength(0);
    // urlとtitleは取得できること
    expect(result.url).toBeDefined();
    expect(result.title).toBeDefined();
  });

  // ElementInfoの型構造が後方互換を維持していること
  it('ElementInfoの必須フィールドが存在する', async () => {
    await page.setContent(`
      <html><body>
        <a href="/test" id="link1">テストリンク</a>
        <input type="checkbox" checked />
      </body></html>
    `);

    const result = await analyzeDom(page);
    const link = result.elements.find(e => e.tag === 'a');
    const checkbox = result.elements.find(e => e.type === 'checkbox');

    // aタグの必須フィールド
    expect(link).toBeDefined();
    if (link) {
      expect(typeof link.index).toBe('number');
      expect(typeof link.tag).toBe('string');
      expect(typeof link.text).toBe('string');
      expect(link.href).toBeDefined();
    }

    // checkboxの状態フィールド
    expect(checkbox).toBeDefined();
    if (checkbox) {
      expect(typeof checkbox.index).toBe('number');
      expect(checkbox.checked).toBe(true);
    }
  });

  // DomAnalysisResultの構造が後方互換を維持していること
  it('DomAnalysisResultの構造が正しい', async () => {
    await page.setContent(`
      <html><head><title>互換性テスト</title></head><body>
        <button>ボタン</button>
      </body></html>
    `);

    const result = await analyzeDom(page);

    // 必須フィールドの存在確認
    expect(result.url).toBeDefined();
    expect(result.title).toBe('互換性テスト');
    expect(Array.isArray(result.elements)).toBe(true);
    // viewportとpageとscrollはオプショナル
    if (result.viewport) {
      expect(typeof result.viewport.width).toBe('number');
      expect(typeof result.viewport.height).toBe('number');
    }
  });
});
