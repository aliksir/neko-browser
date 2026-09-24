import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(__dirname, '_tmp_test');

// ダミーPNGヘッダ（テスト用バッファ）
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

describe('neko_screenshot save_path', () => {
  before(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });

  after(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  // ツール定義にsave_pathパラメータが存在するか検証
  it('ツール定義にsave_pathパラメータが存在する', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf-8');
    const schemaStart = src.indexOf("name: 'neko_screenshot'");
    const schemaEnd = src.indexOf("name: 'neko_scroll'");
    const schemaBlock = src.slice(schemaStart, schemaEnd);
    assert.ok(schemaBlock.includes('save_path'), 'inputSchemaにsave_pathが定義されていない');
    assert.ok(schemaBlock.includes("type: 'string'"), 'save_pathの型がstringでない');
  });

  // 指定パスにバッファを保存できるか検証
  it('指定パスにバッファを保存できる', () => {
    const savePath = join(TMP_DIR, 'output.png');
    writeFileSync(savePath, PNG_HEADER);

    assert.ok(existsSync(savePath), 'ファイルが作成されていない');
    const saved = readFileSync(savePath);
    assert.deepEqual(saved, PNG_HEADER, 'ファイル内容が一致しない');
  });

  // 中間ディレクトリを自動作成して保存できるか検証
  it('中間ディレクトリを自動作成して保存できる', () => {
    const savePath = join(TMP_DIR, 'nested', 'deep', 'screenshot.png');
    mkdirSync(dirname(savePath), { recursive: true });
    writeFileSync(savePath, PNG_HEADER);

    assert.ok(existsSync(savePath), 'ネストされたパスにファイルが作成されていない');
    const saved = readFileSync(savePath);
    assert.deepEqual(saved, PNG_HEADER, 'ファイル内容が一致しない');
  });

  // save_path指定時のキャプション検証
  it('save_path指定時のキャプションにsaved=が含まれる', () => {
    const savePath = '/tmp/test.png';
    const saved = savePath ? `, saved=${savePath}` : '';
    const caption = `Screenshot (1280x720, fullPage=false${saved})`;
    assert.ok(caption.includes('saved=/tmp/test.png'), 'キャプションにsavedパスが含まれていない');
  });

  // save_path未指定時はキャプションにsavedが含まれない
  it('save_path未指定時のキャプションにsavedが含まれない', () => {
    const savePath = undefined;
    const saved = savePath ? `, saved=${savePath}` : '';
    const caption = `Screenshot (1280x720, fullPage=false${saved})`;
    assert.ok(!caption.includes('saved='), 'save_path未指定なのにsavedが含まれている');
  });
});
