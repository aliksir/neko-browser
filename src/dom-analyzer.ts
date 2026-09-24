/**
 * DOM解析エンジン
 * page.evaluate() でブラウザ内 JS を実行し、インタラクティブ要素に
 * data-mcp-index 属性を付与して要素情報と状態を返す。
 * iframe を含む全フレームを走査し、フレームをまたいだ通しインデックスで採番する。
 */

import type { Page, Frame } from 'playwright';
import type { ElementInfo, ViewportInfo, PageInfo, ScrollInfo } from './types.js';

/** data-mcp-index 属性名 */
const MCP_INDEX_ATTR = 'data-mcp-index';

// 1回の解析で取得する要素数の上限（全フレーム合計に適用）
// PA Studio等の複雑なSPAでは右パネル要素が200超になるため300に拡大
export const DEFAULT_MAX_ELEMENTS = 300;

/** analyzeDom の返却値（server.ts が domResult.* としてアクセスするため） */
export interface DomAnalysisResult {
  /** ページ URL（page.url() から取得） */
  url: string;
  /** ページタイトル（page.title() から取得） */
  title: string;
  /** インタラクティブ要素一覧（data-mcp-index 付与済み、全フレーム分を通しindexで格納） */
  elements: ElementInfo[];
  /** ビューポートサイズ */
  viewport?: ViewportInfo;
  /** ページ全体サイズ（メインフレーム基準） */
  page?: PageInfo;
  /** スクロール位置（メインフレーム基準） */
  scroll?: ScrollInfo;
  /** 打ち切り前の候補の総数（全フレームの非表示を除いたインタラクティブ要素の合計） */
  totalCandidates: number;
  /** 上限（maxElements）で打ち切ったか。totalCandidates > elements.length のとき true */
  truncated: boolean;
}

/** 1フレーム分の evaluate 結果の型 */
interface FrameEvalResult {
  elements: Array<{
    index: number;
    tag: string;
    text: string;
    role?: string;
    automationId?: string;
    id?: string;
    placeholder?: string;
    href?: string;
    type?: string;
    value?: string;
    checked?: boolean;
    disabled?: boolean;
    isContentEditable?: boolean;
    irreversible?: boolean;
  }>;
  page: { width: number; height: number };
  scroll: { x: number; y: number };
  /** このフレームの候補の総数（非表示を除外した後、max で絞り込む前の件数） */
  total: number;
}

// 不可逆操作パターン（jev-browser MIT 由来の思想、コード非移植）
const IRREVERSIBLE_PATTERNS: RegExp[] = [
  // 送信系
  /submit|send|送信|発注|place\s*order|注文|apply|申請/i,
  // 削除系
  /delete|remove|削除|drop|unsubscribe|退会|解約/i,
  // 決済系
  /purchase|buy|checkout|pay|購入|支払|決済/i,
  // 確定系
  /confirm|finalize|approve|確定|承認|execute|実行/i,
];

/** 要素テキストが不可逆操作のパターンに一致するか判定（サーバ側で使用） */
export function isIrreversibleAction(text: string, ariaLabel?: string): boolean {
  const target = [text, ariaLabel || ''].join(' ');
  return IRREVERSIBLE_PATTERNS.some(p => p.test(target));
}

/**
 * 単一フレームの古い data-mcp-index 属性を消去する。
 * detached frame（走査中にDOMから切り離された iframe）は evaluate がエラーになるため
 * try-catch でスキップし、console.error で警告のみ出す。
 */
async function clearFrameIndexAttributes(frame: Frame): Promise<void> {
  try {
    await frame.evaluate((attr: string) => {
      const elements = document.querySelectorAll(`[${attr}]`);
      for (const el of Array.from(elements)) {
        el.removeAttribute(attr);
      }
    }, MCP_INDEX_ATTR);
  } catch (err) {
    console.error(
      `[dom-analyzer] clearIndexAttributes: detached frame をスキップしました (${frame.url()}): ${err}`
    );
  }
}

/**
 * DOM内の古い data-mcp-index 属性を全フレームから全消去する。
 * navigate 後や get_state 再呼び出し前に実行する。
 */
export async function clearIndexAttributes(page: Page): Promise<void> {
  // 全フレーム（メインフレーム + iframe）を対象にする
  for (const frame of page.frames()) {
    await clearFrameIndexAttributes(frame);
  }
}

/**
 * 単一フレーム内のインタラクティブ要素を解析し、data-mcp-index を付与する。
 * index はフレームをまたいだ通し番号にするため startIndex から採番する。
 *
 * @param frame - 解析対象の Playwright Frame
 * @param startIndex - このフレームの最初の要素に割り当てるインデックス
 * @param maxCount - このフレームで取得できる要素数の上限（全フレーム合計の残り枠）
 */
async function analyzeFrameElements(
  frame: Frame,
  startIndex: number,
  maxCount: number
): Promise<FrameEvalResult> {
  return frame.evaluate(
    ({
      attr,
      start,
      max,
    }: {
      attr: string;
      start: number;
      max: number;
    }): FrameEvalResult => {
      /** 要素が非表示かどうかを判定 */
      function isHidden(el: Element): boolean {
        const style = window.getComputedStyle(el);
        if (style.display === 'none') return true;
        if (style.visibility === 'hidden') return true;
        // offsetParent が null の場合は非表示（fixed 要素は除外しない）
        if ((el as HTMLElement).offsetParent === null) {
          if (style.position !== 'fixed') return true;
        }
        return false;
      }

      /** 要素が viewport 内にあるかどうかを判定 */
      function isInViewport(el: Element): boolean {
        const rect = el.getBoundingClientRect();
        return (
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight &&
          rect.left < window.innerWidth
        );
      }

      /** テキストを 100 文字に切り詰める */
      function truncate(text: string, limit: number = 100): string {
        const trimmed = text.trim().replace(/\s+/g, ' ');
        return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
      }

      // インタラクティブ要素のセレクタ（Fluent UI / ARIA対応拡張）
      const selector = [
        'a',
        'button',
        'input',
        'select',
        'textarea',
        '[role="button"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="textbox"]',
        '[role="searchbox"]',
        '[role="combobox"]',
        '[role="listbox"]',
        '[role="option"]',
        '[role="switch"]',
        '[role="slider"]',
        '[role="menuitem"]',
        '[role="menuitemcheckbox"]',
        '[role="menuitemradio"]',
        '[role="tab"]',
        '[role="treeitem"]',
        '[role="link"]',
        '[role="spinbutton"]',
        '[role="gridcell"]',
        '[onclick]',
        '[tabindex]',
        '[contenteditable="true"]',
        // neko_drag(機能7)の対象にするため、role/tabindexを持たない素のdraggable要素も拾う
        '[draggable="true"]',
        // Fluent UI v8 固有セレクタ（Power Apps Studio 等の Microsoft 製品向け）
        '[data-is-focusable="true"]',
        '[data-automationid]',
      ].join(', ');

      const all = Array.from(document.querySelectorAll(selector));

      // 非表示を除外
      const visible = all.filter((el) => !isHidden(el));

      // viewport 内を優先して max まで絞り込む（max は全フレーム合計の残り枠）
      const inViewport: Element[] = [];
      const outViewport: Element[] = [];
      for (const el of visible) {
        if (isInViewport(el)) {
          inViewport.push(el);
        } else {
          outViewport.push(el);
        }
      }

      const selected = [...inViewport, ...outViewport].slice(0, max);

      // インデックス付与 & 情報収集（フレームをまたいだ通し番号にする）
      const elements = selected.map((el, i) => {
        const index = start + i;
        el.setAttribute(attr, String(index));

        const htmlEl = el as HTMLElement;
        const inputEl = el as HTMLInputElement;
        const aEl = el as HTMLAnchorElement;
        const tag = el.tagName.toLowerCase();

        // テキスト: textContent → aria-label → title の順で取得
        // 空白だけのtextContentより、利用者向けのaria-label/titleを優先する
        const contentText = htmlEl.textContent?.trim() ?? '';
        const rawText =
          contentText ||
          htmlEl.getAttribute('aria-label') ||
          htmlEl.getAttribute('title') ||
          '';
        const text = truncate(rawText);

        const info: {
          index: number;
          tag: string;
          text: string;
          role?: string;
          automationId?: string;
          id?: string;
          placeholder?: string;
          href?: string;
          type?: string;
          value?: string;
          checked?: boolean;
          disabled?: boolean;
          isContentEditable?: boolean;
          irreversible?: boolean;
        } = { index, tag, text };

        // Power PlatformのFluent UI要素を絞り込めるよう識別属性を保持する
        const role = htmlEl.getAttribute('role');
        const automationId = htmlEl.getAttribute('data-automationid');
        if (role !== null) info.role = role;
        if (automationId !== null) info.automationId = automationId;

        // id属性（css/id条件検索用。空文字は入れない）
        const idAttr = htmlEl.getAttribute('id');
        if (idAttr) info.id = idAttr;

        // placeholder（input/textarea）
        const placeholder = htmlEl.getAttribute('placeholder');
        if (placeholder !== null) info.placeholder = placeholder;

        // href（a タグ）
        if (tag === 'a') {
          const href = aEl.getAttribute('href');
          if (href !== null) info.href = href;
        }

        // type（input タグ）
        if (tag === 'input') {
          info.type = inputEl.type || 'text';
          info.value = inputEl.value;
          if (inputEl.type === 'checkbox' || inputEl.type === 'radio') {
            info.checked = inputEl.checked;
          }
        } else if (tag === 'select' || tag === 'textarea') {
          info.value = (el as HTMLTextAreaElement | HTMLSelectElement).value;
        }

        // disabled
        const disabled = (htmlEl as HTMLInputElement).disabled;
        if (disabled) info.disabled = true;

        // contenteditable
        if (htmlEl.isContentEditable) info.isContentEditable = true;

        // 不可逆操作パターン検出（jev-browser MIT 由来の思想）
        // ブラウザコンテキスト内で実行するため、パターンをインライン定義する
        const irreversiblePatterns = [
          /submit|send|送信|発注|place\s*order|注文|apply|申請/i,
          /delete|remove|削除|drop|unsubscribe|退会|解約/i,
          /purchase|buy|checkout|pay|購入|支払|決済/i,
          /confirm|finalize|approve|確定|承認|execute|実行/i,
        ];
        const ariaLabel = htmlEl.getAttribute('aria-label') || '';
        const checkTarget = [text, ariaLabel].join(' ');
        if (irreversiblePatterns.some(p => p.test(checkTarget))) {
          info.irreversible = true;
        }

        return info;
      });

      return {
        elements,
        // 打ち切りの有無を呼び出し元で判定するため、絞り込み前の件数も返す
        total: visible.length,
        page: {
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        },
        scroll: {
          x: window.scrollX,
          y: window.scrollY,
        },
      };
    },
    { attr: MCP_INDEX_ATTR, start: startIndex, max: maxCount }
  );
}

/**
 * インタラクティブ要素を解析し、連番インデックスを付与して DomAnalysisResult を返す。
 * iframe を含む全フレームを走査し、フレームをまたいだ通しインデックスで採番する。
 *
 * 処理順:
 * 1. 全フレームの古い data-mcp-index を全消去
 * 2. page.frames() で全フレームを列挙し、順に解析（通しindex採番のため並列化しない）
 * 3. 各フレームで非表示要素を除外し、viewport 内要素を優先して残り枠まで絞り込み
 * 4. 各要素に data-mcp-index="N"（フレームをまたいだ通し番号）を付与
 * 5. 要素情報（frame プロパティ含む）・viewport・scroll を収集して返却
 *
 * @param page - Playwright Page オブジェクト
 * @param maxElements - 取得する要素数の上限（全フレーム合計、デフォルト DEFAULT_MAX_ELEMENTS）
 * @returns DomAnalysisResult
 */
export async function analyzeDom(
  page: Page,
  maxElements: number = DEFAULT_MAX_ELEMENTS
): Promise<DomAnalysisResult> {
  // 古い属性を先に消去してから再付与する（全フレーム対応版を先に呼ぶ）
  await clearIndexAttributes(page);

  const url = page.url();
  const title = await page.title();

  // ビューポートサイズ（Playwright API から取得。viewport: null 設定時は
  // viewportSize() が null を返すため、ブラウザ内 JS で実サイズを取得する）
  const viewportSize = page.viewportSize();
  let viewport: ViewportInfo | undefined;
  if (viewportSize) {
    viewport = { width: viewportSize.width, height: viewportSize.height };
  } else {
    const jsSize = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    viewport = { width: jsSize.width, height: jsSize.height };
  }

  const mainFrame = page.mainFrame();
  const allElements: ElementInfo[] = [];
  let pageInfo: PageInfo | undefined;
  let scrollInfo: ScrollInfo | undefined;
  let index = 0;
  // 打ち切り前の候補の総数（全フレーム合計）
  let totalCandidates = 0;

  // フレームをまたいだ通しindex採番のため、Promise.allSettled ではなく順次実行する
  for (const frame of page.frames()) {
    // 上限に達した後のフレームも、候補の総数を数えるために走査を続ける。
    // 残り枠 0 で呼ぶため index の付与は行われない（採番・返す要素は従来と同じ）

    // detached frame（走査中にDOMから切り離された iframe）は evaluate 前にスキップする
    if (frame.isDetached()) {
      console.error(
        `[dom-analyzer] analyzeDom: detached frame をスキップしました (${frame.url()})`
      );
      continue;
    }

    const isMainFrame = frame === mainFrame;

    try {
      const result = await analyzeFrameElements(frame, index, Math.max(0, maxElements - index));
      totalCandidates += result.total;

      for (const el of result.elements) {
        allElements.push({
          ...el,
          frame: isMainFrame ? undefined : frame.url(),
        });
      }
      index += result.elements.length;

      // page/scroll はメインフレームの値を採用する
      if (isMainFrame) {
        pageInfo = result.page;
        scrollInfo = result.scroll;
      }
    } catch (err) {
      // detached frame（走査中にDOMから切り離された iframe）はスキップ
      console.error(
        `[dom-analyzer] analyzeDom: detached frame をスキップしました (${frame.url()}): ${err}`
      );
    }
  }

  return {
    url,
    title,
    elements: allElements,
    viewport,
    page: pageInfo,
    scroll: scrollInfo,
    totalCandidates,
    // 返した件数より候補が多ければ上限で打ち切ったことになる
    truncated: totalCandidates > allElements.length,
  };
}

// ---------------------------------------------------------------------------
// 構造解析（見出し・ランドマーク） — neko_snapshot の interactive_only=false 用
// analyzeDom とは完全に独立した追加機能。既存 analyzeDom / analyzeFrameElements には触れない。
// ---------------------------------------------------------------------------

/** 構造要素（見出し・ランドマーク）1件分の情報 */
export interface StructureNode {
  /** 種別: heading=見出し要素、landmark=ランドマーク要素 */
  kind: 'heading' | 'landmark';
  /** タグ名（小文字）。role属性を持つ要素はrole値を優先する（Fluent UI等でdivにroleを付与するケースが多く、タグ名だけでは何のランドマークか判別できないため） */
  tag: string;
  /** テキスト内容（80文字まで、空白正規化済み） */
  text: string;
  /** iframeのURL（メインフレームの場合はundefined） */
  frame?: string;
}

/** 1フレーム分の構造解析 evaluate 結果の型 */
interface FrameStructureEvalResult {
  nodes: Array<{ kind: 'heading' | 'landmark'; tag: string; text: string }>;
}

/**
 * 単一フレーム内の見出し・ランドマーク要素を解析する。
 * インタラクティブ要素（analyzeFrameElements）とは別に、ページ全体の骨格把握用に取得する。
 *
 * @param frame - 解析対象の Playwright Frame
 * @param maxCount - このフレームで取得できるノード数の上限（全フレーム合計の残り枠）
 */
async function analyzeFrameStructure(
  frame: Frame,
  maxCount: number
): Promise<FrameStructureEvalResult> {
  return frame.evaluate(
    ({ max }: { max: number }): FrameStructureEvalResult => {
      /** 要素が非表示かどうかを判定（analyzeFrameElements の isHidden と同一ロジック） */
      function isHidden(el: Element): boolean {
        const style = window.getComputedStyle(el);
        if (style.display === 'none') return true;
        if (style.visibility === 'hidden') return true;
        if ((el as HTMLElement).offsetParent === null) {
          if (style.position !== 'fixed') return true;
        }
        return false;
      }

      /** テキストを80文字に切り詰める（空白正規化込み） */
      function truncate(text: string, limit: number = 80): string {
        const trimmed = text.trim().replace(/\s+/g, ' ');
        return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
      }

      // 見出し対象セレクタ
      const headingSelector = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
      // ランドマーク対象セレクタ（aria-label付きform/sectionのみ対象。無印は多すぎてノイズになるため除外）
      const landmarkSelector = [
        'main',
        'nav',
        'header',
        'footer',
        'aside',
        'form[aria-label]',
        'section[aria-label]',
        '[role="main"]',
        '[role="navigation"]',
        '[role="banner"]',
        '[role="contentinfo"]',
        '[role="complementary"]',
        '[role="region"]',
        '[role="search"]',
        '[role="form"]',
      ].join(',');

      const nodes: Array<{ kind: 'heading' | 'landmark'; tag: string; text: string }> = [];

      // heading: textContent をそのまま使う（見出しは装飾より内容が主）
      const headings = Array.from(document.querySelectorAll(headingSelector)).filter(
        (el) => !isHidden(el)
      );
      for (const el of headings) {
        if (nodes.length >= max) break;
        const role = el.getAttribute('role');
        const tag = role ?? el.tagName.toLowerCase();
        const text = truncate((el as HTMLElement).textContent ?? '');
        nodes.push({ kind: 'heading', tag, text });
      }

      // landmark: aria-label を優先し、無ければ textContent。どちらも空なら (unlabeled) として残す
      const landmarks = Array.from(document.querySelectorAll(landmarkSelector)).filter(
        (el) => !isHidden(el)
      );
      for (const el of landmarks) {
        if (nodes.length >= max) break;
        const htmlEl = el as HTMLElement;
        const role = el.getAttribute('role');
        const tag = role ?? el.tagName.toLowerCase();
        const rawText = htmlEl.getAttribute('aria-label') || htmlEl.textContent || '';
        const text = truncate(rawText) || '(unlabeled)';
        nodes.push({ kind: 'landmark', tag, text });
      }

      return { nodes };
    },
    { max: maxCount }
  );
}

/**
 * ページ全体の構造要素（見出し・ランドマーク）を解析する。
 * neko_snapshot(interactive_only=false) が呼び出す。analyzeDom とは独立しており、
 * 既存の analyzeDom / analyzeFrameElements の挙動には一切影響しない。
 *
 * 処理順:
 * 1. page.frames() で全フレームを列挙し、順に解析（analyzeDom と同じくdetachedはスキップ）
 * 2. 各フレームで非表示要素を除外し、見出し→ランドマークの順で残り枠まで収集
 * 3. iframe 内の要素には frame プロパティを付与
 *
 * @param page - Playwright Page オブジェクト
 * @param maxNodes - 取得するノード数の上限（全フレーム合計、既定100）
 * @returns StructureNode[]
 */
export async function analyzeStructure(
  page: Page,
  maxNodes: number = 100
): Promise<StructureNode[]> {
  const mainFrame = page.mainFrame();
  const allNodes: StructureNode[] = [];

  for (const frame of page.frames()) {
    if (allNodes.length >= maxNodes) break;

    // detached frame（走査中にDOMから切り離された iframe）は evaluate 前にスキップする
    if (frame.isDetached()) {
      console.error(
        `[dom-analyzer] analyzeStructure: detached frame をスキップしました (${frame.url()})`
      );
      continue;
    }

    const isMainFrame = frame === mainFrame;

    try {
      const result = await analyzeFrameStructure(frame, maxNodes - allNodes.length);
      for (const node of result.nodes) {
        allNodes.push({
          ...node,
          frame: isMainFrame ? undefined : frame.url(),
        });
      }
    } catch (err) {
      // detached frame（走査中にDOMから切り離された iframe）はスキップ
      console.error(
        `[dom-analyzer] analyzeStructure: detached frame をスキップしました (${frame.url()}): ${err}`
      );
    }
  }

  return allNodes;
}
