/**
 * Processor アーキテクチャ（開発指示書 6・18章）
 *
 *   Tool
 *    ↓
 *   Processor
 *    ├── BrowserProcessor  (ファイルをブラウザ内で処理する。現在のツールはすべてこちら)
 *    └── ServerProcessor   (インターフェースのみ。実装したものは現在ない)
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
 * 現在これを継承した実装はない（ファイルはブラウザ内で処理する方針。AI補助は src/lib/ai/ が
 * API Route 経由で行う）。将来必要になったときの差し替え口として、インターフェースだけ残している。
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
