import { ServerProcessor } from "../types";

/**
 * Phase 1 用の ServerProcessor プレースホルダー。
 *
 * 高度なOCR・PDF→Excel・PDF→Word・大容量PDF処理・複雑なAI処理など
 * サーバー側での処理が適切な機能は、将来このクラスを継承した
 * 具象クラス（例: OcrServerProcessor, PdfToExcelServerProcessor）を実装し、
 * API Route や Supabase Edge Functions などを呼び出す。
 *
 * Phase 1 では実装せず、「差し替え可能な構造」だけを用意する（7章）。
 */
export class NotImplementedServerProcessor<Input, Output> extends ServerProcessor<
  Input,
  Output
> {
  constructor(private readonly toolName: string) {
    super();
  }

  async process(_input: Input): Promise<Output> {
    void _input;
    throw new Error(
      `「${this.toolName}」のサーバー処理はPhase 2以降で実装予定です。`
    );
  }
}
