/**
 * Processor アーキテクチャ（開発指示書 6・18章）
 *
 *   Tool
 *    ↓
 *   Processor
 *    ├── BrowserProcessor  (Phase 1 で実装)
 *    └── ServerProcessor   (Phase 1 はインターフェースのみ。実装はPhase 2以降)
 *
 * UI コンポーネントは Processor クラスの process() だけを呼び出し、
 * 画像処理・PDF処理などの具体的なロジックには直接触れない。
 * これにより将来、同じ Tool のまま処理エンジンを
 * Browser <-> Server で差し替えられる。
 */

export type ProcessorEngine = "browser" | "server";

export interface Processor<Input, Output> {
  readonly engine: ProcessorEngine;
  process(input: Input): Promise<Output>;
}

/** ブラウザ(クライアント)上で完結する処理。ファイルは外部に送信されない */
export abstract class BrowserProcessor<Input, Output>
  implements Processor<Input, Output>
{
  readonly engine: ProcessorEngine = "browser";
  abstract process(input: Input): Promise<Output>;
}

/**
 * サーバー側で処理するための Processor。
 * Phase 1 では本格実装せず、将来 API Route / Edge Function 等を
 * 呼び出す実装に差し替えられるようインターフェースのみ用意する（7章）。
 */
export abstract class ServerProcessor<Input, Output>
  implements Processor<Input, Output>
{
  readonly engine: ProcessorEngine = "server";
  abstract process(input: Input): Promise<Output>;
}

/** 画像処理系 Processor の共通出力形式 */
export interface ImageProcessorOutput {
  blob: Blob;
  url: string;
  width: number;
  height: number;
  mimeType: string;
  sizeBytes: number;
}

/** PDF処理系 Processor の共通出力形式（1ファイルを返す場合） */
export interface PdfProcessorOutput {
  blob: Blob;
  url: string;
  pageCount: number;
  sizeBytes: number;
}

/**
 * PDF分割・PDF→画像など、複数ファイルを出力するProcessorの
 * 個々の出力アイテム共通形式。ダウンロード用のファイル名も
 * Processor側で決定し、UI側でファイル名生成ロジックを重複させない。
 */
export interface NamedFileOutput {
  blob: Blob;
  /** sanitizeFileName/replaceExtension適用済みの拡張子込みファイル名 */
  suggestedName: string;
  sizeBytes: number;
}
