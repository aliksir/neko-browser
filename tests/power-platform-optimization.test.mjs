import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { NekoBrowserServer } from '../dist/server.js';
import { analyzeDom } from '../dist/dom-analyzer.js';

let browser;
let page;
let server;

describe('Power Platform操作最適化', () => {
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

  test('contentEditableを消去して置換入力できる', async () => {
    await page.setContent('<div role="textbox" contenteditable="true">旧式</div>');
    const analyzed = await analyzeDom(page);
    await server.nekoReplaceText({ index: analyzed.elements[0].index, text: '新しい式' });

    assert.equal(await page.locator('[contenteditable="true"]').textContent(), '新しい式');
  });

  test('Power Platformのautomationidで要素を検索できる', async () => {
    await page.setContent(
      '<button role="button" data-automationid="saveButton">保存</button>' +
        '<button data-automationid="cancelButton">キャンセル</button>',
    );
    const response = await server.nekoFindElements({ automation_id: 'save' });
    const body = JSON.parse(response.content[0].text);

    assert.equal(body.count, 1);
    assert.equal(body.elements[0].automationId, 'saveButton');
    assert.equal('value' in body.elements[0], false);
  });

  test('動的テキストを表示まで待機できる', async () => {
    await page.setContent(
      '<div id="status"></div><script>' +
        'setTimeout(() => document.querySelector("#status").textContent = "保存完了", 50)' +
        '</script>',
    );
    const response = await server.nekoWaitFor({ text: '保存完了', timeout: 1000 });

    assert.match(response.content[0].text, /reached state: visible/);
  });

  test('未出現テキストのhidden待機を成功扱いしない', async () => {
    await page.setContent('<div>別の状態</div>');
    const response = await server.nekoWaitFor({
      text: '存在しない状態',
      state: 'hidden',
      timeout: 100,
    });

    assert.match(response.content[0].text, /Wait condition timed out/);
  });

  test('確定キーを許可リストに制限する', async () => {
    await page.setContent('<input value="旧値">');
    const analyzed = await analyzeDom(page);
    const response = await server.nekoReplaceText({
      index: analyzed.elements[0].index,
      text: '新値',
      commit_key: 'Control+S',
    });

    assert.match(response.content[0].text, /commit_key is not allowed/);
  });

  test('読み取り専用textboxには入力しない', async () => {
    await page.setContent('<div role="textbox" aria-readonly="true">表示専用</div>');
    const analyzed = await analyzeDom(page);
    const response = await server.nekoReplaceText({ index: analyzed.elements[0].index, text: '変更' });

    assert.match(response.content[0].text, /is not editable/);
  });

  test('条件指定クリックはautomationidで一意に対象を再同定する', async () => {
    await page.setContent('<button data-automationid="saveButton">保存</button>');
    const armed = await server.nekoArmDestructive({ automation_id: 'saveButton' });
    const token = JSON.parse(armed.content[0].text).token;
    const response = await server.nekoClickTarget({
      automation_id: 'saveButton',
      expected_text: '保存',
      timeout: 1000,
      confirmation_token: token,
    });

    assert.match(response.content[0].text, /Clicked unique target/);
  });

  test('条件指定クリックはmcp_indexで無名のPower Appsカード操作を一意にする', async () => {
    await page.setContent('<button>一</button><button>二</button>');
    const targetIndex = 1;
    const armed = await server.nekoArmDestructive({ mcp_index: targetIndex });
    assert.doesNotMatch(armed.content[0].text, /^Error:/);
    const token = JSON.parse(armed.content[0].text).token;
    const response = await server.nekoClickTarget({
      mcp_index: targetIndex,
      confirmation_token: token,
    });

    assert.match(response.content[0].text, /Clicked unique target/);
  });

  test('条件指定クリックは複数一致を拒否する', async () => {
    await page.setContent(
      '<button data-automationid="saveButton">保存</button>' +
        '<button data-automationid="saveButton">保存</button>',
    );
    const response = await server.nekoClickTarget({ automation_id: 'saveButton' });

    assert.match(response.content[0].text, /Target is ambiguous/);
  });

  test('条件指定置換は入力欄を再検索して置換する', async () => {
    await page.setContent('<input data-automationid="formulaEditor" value="旧式">');
    const response = await server.nekoReplaceTarget({
      automation_id: 'formulaEditor',
      text: '新しい式',
    });

    assert.match(response.content[0].text, /Replaced unique target/);
    assert.equal(await page.locator('input').inputValue(), '新しい式');
  });

  test('危険なクリックは明示確認なしにブロックする', async () => {
    await page.setContent('<button data-automationid="publishButton">公開</button>');
    const response = await server.nekoClickTarget({ automation_id: 'publishButton' });

    assert.match(response.content[0].text, /Click blocked/);
  });

  test('危険なクリックは別呼び出しの一回限りトークンで実行する', async () => {
    await page.setContent('<button data-automationid="publishButton">公開</button>');
    const armed = await server.nekoArmDestructive({ automation_id: 'publishButton' });
    const token = JSON.parse(armed.content[0].text).token;
    const clicked = await server.nekoClickTarget({
      automation_id: 'publishButton',
      confirmation_token: token,
    });
    const reused = await server.nekoClickTarget({
      automation_id: 'publishButton',
      confirmation_token: token,
    });

    assert.match(clicked.content[0].text, /Clicked unique target/);
    assert.match(reused.content[0].text, /Click blocked/);
  });

  test('状態取得で入力値を返さない', async () => {
    await page.setContent('<input value="秘密の式">');
    const response = await server.nekoGetState({});
    const body = JSON.parse(response.content[0].text);

    assert.equal('value' in body.interactive_elements[0], false);
  });

  test('iframeをまたぐテキスト待機は後続iframeの有無に依存しない', async () => {
    await page.setContent(
      '<iframe srcdoc="<div>保存完了</div>"></iframe><iframe srcdoc="<div>別の状態</div>"></iframe>',
    );
    const response = await server.nekoWaitFor({ text: '保存完了', timeout: 1000 });

    assert.match(response.content[0].text, /reached state: visible/);
  });

  test('Power Platformでは旧来の生クリックを既定で止める', async () => {
    server.currentPage = {
      url: () => 'https://make.powerapps.com/',
      frames: () => [{ url: () => 'https://make.powerapps.com/' }],
    };
    const response = await server.nekoClick({ index: 0 });

    assert.match(response.content[0].text, /Raw click is disabled on Power Platform/);
  });

  test('Power Pages系ホストでもraw操作とファイル送信を既定で止める', async () => {
    server.currentPage = {
      url: () => 'https://contoso.powerappsportals.com/',
      frames: () => [{ url: () => 'https://contoso.powerappsportals.com/' }],
    };
    const click = await server.nekoClick({ index: 0 });
    const upload = await server.nekoUploadFile({
      index: 0,
      file_paths: ['C:\\test\\example.txt'],
    });

    assert.match(click.content[0].text, /Raw click is disabled on Power Platform/);
    assert.match(upload.content[0].text, /Raw file upload is disabled on Power Platform/);
  });

  test('非Power Platformの外側ページでも埋め込みiframeを保護する', async () => {
    server.currentPage = {
      url: () => 'https://contoso.sharepoint.com/',
      frames: () => [
        { url: () => 'https://contoso.sharepoint.com/' },
        { url: () => 'https://apps.powerapps.com/play/e/default-app' },
      ],
    };
    const response = await server.nekoClick({ index: 0 });

    assert.match(response.content[0].text, /Raw click is disabled on Power Platform/);
  });

  test('任意JavaScriptとHTML全量出力は既定で止める', async () => {
    const evaluate = await server.nekoEvaluate({ expression: 'document.title' });
    const html = await server.nekoGetHtml({});

    assert.match(evaluate.content[0].text, /JavaScript evaluation is disabled/);
    assert.match(html.content[0].text, /HTML export is disabled/);
  });

  test('属性取得では値・URL・非自動化data属性を秘匿する', async () => {
    await page.setContent(
      '<input value="機密値" href="https://example.test/?token=secret" data-token="secret" data-automationid="formulaEditor">',
    );
    const analyzed = await analyzeDom(page);
    const response = await server.nekoGetAttribute({ index: analyzed.elements[0].index });
    const attributes = JSON.parse(response.content[0].text);

    assert.equal(attributes.value, '<redacted>');
    assert.equal(attributes.href, '<redacted>');
    assert.equal(attributes['data-token'], '<redacted>');
    assert.equal(attributes['data-automationid'], 'formulaEditor');
  });
});
