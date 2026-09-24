/**
 * iframe要素取得テスト
 *
 * dom-analyzer.ts の analyzeDom() が iframe を含む全フレームを走査し、
 * フレームをまたいだ通しインデックスで要素を採番できることを検証する。
 * Playwrightのブラウザ起動が必要なため、CI環境ではスキップする。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { analyzeDom } from '../src/dom-analyzer.js';

const isCI = process.env['CI'] === 'true';

describe.skipIf(isCI)('iframe要素取得テスト', () => {
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

  it('メインフレームの要素にインデックスが振られる', async () => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <button id="btn1">Button 1</button>
        <input id="input1" type="text" placeholder="名前">
      </body></html>
    `);

    const result = await analyzeDom(page);

    expect(result.elements.length).toBe(2);
    expect(result.elements[0]?.tag).toBe('button');
    expect(result.elements[0]?.index).toBe(0);
    expect(result.elements[0]?.frame).toBeUndefined();
    expect(result.elements[1]?.tag).toBe('input');
    expect(result.elements[1]?.index).toBe(1);
    expect(result.elements[1]?.frame).toBeUndefined();
  });

  it('iframe内の要素にも通しインデックスが振られる', async () => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <button id="main-btn">Main Button</button>
        <iframe id="frame1"></iframe>
      </body></html>
    `);

    // iframe内にコンテンツを注入(srcdocの文字列エスケープを避けるためevaluateで直接書き込む)
    await page.evaluate(() => {
      const iframe = document.getElementById('frame1') as HTMLIFrameElement;
      const doc = iframe.contentDocument!;
      doc.open();
      doc.write('<button id="iframe-btn">Iframe Button</button>');
      doc.close();
    });
    await page.waitForTimeout(300);

    const result = await analyzeDom(page);

    // メインフレーム1個 + iframe内1個 = 合計2個
    expect(result.elements.length).toBe(2);

    const mainEl = result.elements.find((el) => el.text === 'Main Button');
    const iframeEl = result.elements.find((el) => el.text === 'Iframe Button');

    expect(mainEl).toBeDefined();
    expect(mainEl?.frame).toBeUndefined();

    expect(iframeEl).toBeDefined();
    expect(iframeEl?.frame).toBeDefined();

    // インデックスがフレームをまたいで重複せず通し番号になっていること
    const indices = result.elements.map((el) => el.index).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1]);
  });

  it('detached frameでevaluateが失敗してもanalyzeDomはエラーにならずスキップする', async () => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <button id="main-btn">Main Button</button>
        <iframe id="frame1"></iframe>
      </body></html>
    `);
    await page.evaluate(() => {
      const iframe = document.getElementById('frame1') as HTMLIFrameElement;
      const doc = iframe.contentDocument!;
      doc.open();
      doc.write('<button id="iframe-btn">Iframe Button</button>');
      doc.close();
    });
    await page.waitForTimeout(300);

    const frames = page.frames();
    const iframeFrame = frames.find((f) => f !== page.mainFrame());
    expect(iframeFrame).toBeDefined();

    // detached frame相当のevaluate失敗を人工的に再現する
    // 本物のdetached frameはevaluateを呼ぶたびに失敗するため、Onceにせず毎回失敗させる
    vi.spyOn(iframeFrame!, 'evaluate').mockRejectedValue(new Error('Frame was detached'));

    // 例外が投げられずに解析が完了し、メインフレームの要素は取得できること
    const result = await analyzeDom(page);

    expect(result.elements.some((el) => el.text === 'Main Button')).toBe(true);
    expect(result.elements.some((el) => el.text === 'Iframe Button')).toBe(false);
  });
});
