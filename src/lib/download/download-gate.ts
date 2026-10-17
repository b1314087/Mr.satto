/**
 * ダウンロード関所（共通ダウンロード制御）の接続点。
 *
 * Tool Processing → Processed File → [関所] → Download
 *
 * 全ツールが共通の downloadBlob()（src/lib/utils/format.ts）でファイルを保存する。
 * downloadBlob() は保存する前に runWithDownloadAccess() を経由し、ここに登録された
 * 関所（コントローラー）が「今すぐ保存してよいか」を判断する。
 *   - 登録されていない（関所のないページ。例：記入済みPDF→Excelなど、独自の利用制限を持つツール）
 *     → そのまま保存する（従来どおり）。
 *   - 登録されていて、広告視聴が不要（Standard/Premium、有効な利用権あり、広告ゲート無効）
 *     → そのまま保存する。
 *   - 登録されていて、広告視聴が必要 → 保存を保留し、広告の確認画面を表示する。
 *     広告視聴（または代替付与）の後、ユーザーが改めて「ダウンロードする」を押した時点で
 *     保留していた保存を実行する。
 *
 * 保存の保留はこのモジュールの中・ブラウザのメモリ上だけで行い、Blob・ファイル名・
 * ファイルの内容をサーバーへ送ることは一切ない（Server Actionにも渡さない）。
 */

/** ゲートの対象となる1件の操作（ダウンロード、または新しいタブでの結果表示など） */
export interface GatedAction {
  /** 同じ操作の二重登録を防ぐための識別子（Blobそのものなど） */
  key: unknown;
  /** 確認画面に表示する名前（ファイル名など） */
  label: string;
  /** 実際の保存・表示を行う処理。ユーザーのクリック操作の中から呼ばれる */
  run: () => void;
}

export interface DownloadGateController {
  /**
   * 操作を保留すべきなら保留して true を返す（呼び出し元は run() を呼ばない）。
   * そのまま実行してよい場合は false を返す。
   */
  intercept(action: GatedAction): boolean;
}

let controller: DownloadGateController | null = null;

/** 関所を登録する。戻り値の関数を呼ぶと登録を解除する（登録が置き換わっていれば何もしない） */
export function registerDownloadGate(next: DownloadGateController): () => void {
  controller = next;
  return () => {
    if (controller === next) controller = null;
  };
}

/** 関所を経由して操作を実行する。関所がなければ、または広告視聴が不要なら、その場で実行する */
export function runWithDownloadAccess(action: GatedAction): void {
  if (controller?.intercept(action)) return;
  action.run();
}
