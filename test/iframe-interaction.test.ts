/**
 * iframe内操作テスト
 *
 * server.ts の resolveLocator() が iframe内の要素にも到達し、
 * クリック・入力操作を実行できることを検証する。
 * resolveLocator() は private メソッドのため、テストからは型を緩めてアクセスする。
 * Playwrightのブラウザ起動が必要なため、CI環境ではスキップする。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { chromium, type Browser, type Page, type Locator } from 'playwright';
import { NekoBrowserServer } from '../src/server.js';
import { analyzeDom } from '../src/dom-analyzer.js';

const isCI = process.env['CI'] === 'true';

/** NekoBrowserServer の private メソッドにアクセスするための最小インターフェース */
interface ServerInternals {
  resolveLocator(page: Page, index: number): Promise<Locator>;
}

function asInternals(server: NekoBrowserServer): ServerInternals {
  return server as unknown as ServerInternals;
}

describe.skipIf(isCI)('iframe内操作テスト', () => {
  let browser: Browser;
  let page: Page;
  let server: ServerInternals;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 30000);

  afterAll(async () => {
    await browser?.close();
  });

  beforeEach(async () => {
    page = await browser.newPage();
    // コンストラクタはMCP Serverインスタンス化のみでブラウザは起動しない
    server = asInternals(new NekoBrowserServer());
  });

  afterEach(async () => {
    await page?.close();
  });

  it('resolveLocator()でiframe内の要素に到達できる', async () => {
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

    const domResult = await analyzeDom(page);
    const iframeEl = domResult.elements.find((el) => el.text === 'Iframe Button');
    expect(iframeEl).toBeDefined();

    const locator = await server.resolveLocator(page, iframeEl!.index);
    expect(await locator.count()).toBe(1);
    expect(await locator.textContent()).toBe('Iframe Button');
  });

  it('iframe内の要素をクリックできる', async () => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <iframe id="frame1"></iframe>
      </body></html>
    `);
    await page.evaluate(() => {
      const iframe = document.getElementById('frame1') as HTMLIFrameElement;
      const doc = iframe.contentDocument!;
      doc.open();
      doc.write('<button id="iframe-btn">Click Me</button>');
      doc.close();
      const btn = doc.getElementById('iframe-btn')!;
      // クリック時にdocument.titleを書き換えてクリック実行の証跡にする
      btn.addEventListener('click', () => {
        doc.title = 'clicked';
      });
    });
    await page.waitForTimeout(300);

    const domResult = await analyzeDom(page);
    const iframeEl = domResult.elements.find((el) => el.text === 'Click Me');
    expect(iframeEl).toBeDefined();

    const locator = await server.resolveLocator(page, iframeEl!.index);
    await locator.click();

    const iframeFrame = page.frames().find((f) => f !== page.mainFrame());
    const title = await iframeFrame?.evaluate(() => document.title);
    expect(title).toBe('clicked');
  });

  it('iframe内のinput要素にテキストを入力できる', async () => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <iframe id="frame1"></iframe>
      </body></html>
    `);
    await page.evaluate(() => {
      const iframe = document.getElementById('frame1') as HTMLIFrameElement;
      const doc = iframe.contentDocument!;
      doc.open();
      doc.write('<input id="iframe-input" type="text" placeholder="入力">');
      doc.close();
    });
    await page.waitForTimeout(300);

    const domResult = await analyzeDom(page);
    const iframeEl = domResult.elements.find((el) => el.tag === 'input');
    expect(iframeEl).toBeDefined();
    expect(iframeEl?.frame).toBeDefined();

    const locator = await server.resolveLocator(page, iframeEl!.index);
    await locator.fill('テスト入力');

    expect(await locator.inputValue()).toBe('テスト入力');
  });
});
