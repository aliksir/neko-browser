/**
 * 共通型定義
 * neko-browser の全モジュールで使用する型
 */

/** インタラクティブ要素の情報 */
export interface ElementInfo {
  /** data-mcp-index で付与された連番インデックス */
  index: number;
  /** タグ名（小文字）: a, button, input, select, textarea 等 */
  tag: string;
  /** textContent（100文字まで）または aria-label */
  text: string;
  /** role属性（ARIAロール） */
  role?: string;
  /** data-automationid属性（Fluent UI / Power Platformの自動化識別子） */
  automationId?: string;
  /** id属性（完全一致検索用。空文字は入れない） */
  id?: string;
  /** placeholder 属性（input/textarea） */
  placeholder?: string;
  /** href 属性（a タグ） */
  href?: string;
  /** type 属性（input タグ）: text, checkbox, radio, submit 等 */
  type?: string;
  /** value 属性（input/select/textarea） */
  value?: string;
  /** checked 状態（checkbox/radio） */
  checked?: boolean;
  /** disabled 属性 */
  disabled?: boolean;
  /** contenteditable="true" の要素か */
  isContentEditable?: boolean;
  /** 不可逆操作の可能性がある要素（送信・削除・決済・確定等のテキストを含む） */
  irreversible?: boolean;
  /** iframeのURL（メインフレームの場合は undefined） */
  frame?: string;
}

/** ビューポートサイズ */
export interface ViewportInfo {
  /** ビューポート幅（px） */
  width: number;
  /** ビューポート高さ（px） */
  height: number;
}

/** ページ全体のサイズ */
export interface PageInfo {
  /** ページ幅（px） */
  width: number;
  /** ページ高さ（px） */
  height: number;
}

/** スクロール位置 */
export interface ScrollInfo {
  /** 水平スクロール量（px） */
  x: number;
  /** 垂直スクロール量（px） */
  y: number;
}

/**
 * ネットワークリクエスト/レスポンスの記録（neko_network 用）
 * context.on('request'/'response'/'requestfailed') のイベントから段階的に埋める。
 * request イベントで生成し、response/requestfailed イベントで追記更新する。
 */
export interface NetworkLogEntry {
  /** 1始まりの連番ID（neko_network detail action で指定する） */
  id: number;
  /** ISO8601形式のリクエスト発生時刻 */
  ts: string;
  /** HTTPメソッド（GET/POST等） */
  method: string;
  /** リクエストURL（maskUrlForLog でマスク済み） */
  url: string;
  /** リソース種別（document/script/xhr/fetch/stylesheet/image等） */
  resourceType: string;
  /** リクエスト元タブのID（解決できない場合は空文字） */
  tabId: string;
  /** リクエストヘッダ（maskHeadersForLog でマスク済み） */
  requestHeaders: Record<string, string>;
  /** HTTPステータスコード（response到達前はnull） */
  status: number | null;
  /** レスポンスヘッダ（maskHeadersForLog でマスク済み。response到達後のみ付与） */
  responseHeaders?: Record<string, string>;
  /** リクエスト所要時間（ミリ秒）。算出不能な場合はnull */
  durationMs?: number | null;
  /** レスポンスサイズ（バイト、content-lengthヘッダから算出）。不明な場合はnull */
  sizeBytes?: number | null;
  /** リクエスト失敗時のエラーテキスト（requestfailedイベントのrequest.failure()から取得） */
  failure?: string;
}

/**
 * コンソールログ/ページエラーの記録（neko_console 用）
 * page.on('console') と page.on('pageerror') の両方をこの型に正規化して格納する。
 */
export interface ConsoleLogEntry {
  /** ISO8601形式の記録時刻 */
  ts: string;
  /** ログレベル（log/info/warn/error/debug/pageerror） */
  level: string;
  /** ログ本文（maskSensitiveText でマスク済み） */
  text: string;
  /** 発生元タブのID */
  tabId: string;
  /** 発生元ファイル位置（"url:line" 形式。msg.location() が取得できた場合のみ付与） */
  location?: string;
}

/**
 * ダウンロードの記録（neko_downloads 用）
 * page.on('download') イベントで in_progress として生成し、保存の成否に応じて
 * completed/failed へ更新する。総司令追加依頼(REQ-20260904-001)対応。
 */
export interface DownloadLogEntry {
  /** 1始まりの連番ID（neko_downloads list で表示する識別子） */
  id: number;
  /** ISO8601形式のダウンロード発生時刻 */
  ts: string;
  /** ダウンロード元URL（maskUrlForLog でマスク済み） */
  url: string;
  /** サーバが提案したファイル名（サニタイズ前の原名） */
  suggestedFilename: string;
  /** 実際に保存した絶対パス（未完了/失敗時は空文字） */
  savedPath: string;
  /** 保存済みファイルサイズ（バイト）。取得できない/未完了の場合はnull */
  sizeBytes: number | null;
  /** ダウンロードの状態 */
  status: 'in_progress' | 'completed' | 'failed';
  /** 失敗理由（status='failed' の場合のみ付与） */
  failure?: string;
  /** 発生元タブのID */
  tabId: string;
}
