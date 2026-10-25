/**
 * PDFツール間のファイル引き継ぎ（工程12）。
 *
 * あるツールの処理結果のPDFを、ダウンロード・再アップロードなしで別のツールへ渡すための、ごく小さな受け渡し口。
 *
 * 方式：このモジュール内の変数（ブラウザのメモリ上）に `File` を1つだけ置き、受け取る側が1回だけ取り出す。
 * 同じタブ内で画面遷移（ツールのページ移動）しても、ページ全体の再読み込みが起きない限りメモリは残る。
 *
 * プライバシー・安全面の決まり（変更しないこと）：
 * - サーバーへは送らない（ネットワークは使わない）。
 * - localStorage / sessionStorage / IndexedDB / Cookie / URL には保存しない（ファイルの中身を永続化しない）。
 * - 取り出したら（または期限が切れたら）メモリから外す。1回しか受け取れない。
 * - ブラウザの再読み込み・別タブで開いた場合はメモリが空なので、何も受け取れず、通常のファイル選択から始まる。
 * - 受け取る側は、ファイル選択と同じ形式・サイズの確認（validateHandoffFile）を必ず通す。
 */

/** 引き継いだPDFを受け取れる期間。これを過ぎた引き継ぎは無かったものとして扱う（古いファイルが突然開くのを防ぐ） */
export const PDF_HANDOFF_TTL_MS = 15 * 60 * 1000;

/** ファイル選択（FileDropzone）の既定の上限と同じ値。引き継ぎでも同じ上限を適用し、制限を迂回させない */
export const PDF_HANDOFF_MAX_SIZE_MB = 50;

export interface PdfHandoff {
  /** 引き継ぐPDF（処理結果。元のファイルではない） */
  file: File;
  /** 引き継ぎ元の表示名（例：「PDF編集」） */
  sourceLabel: string;
  /** 引き継ぎ先のツールID（別のツールが誤って受け取らないようにする） */
  targetToolId: string;
  offeredAt: number;
}

let pending: PdfHandoff | null = null;

/** 引き継ぎ元が「これを渡したい」と置く。前の引き継ぎがあれば置き換える（常に最新の1つだけ） */
export function offerPdfHandoff(file: File, sourceLabel: string, targetToolId: string): void {
  pending = { file, sourceLabel, targetToolId, offeredAt: Date.now() };
}

/**
 * 引き継ぎ先が1回だけ取り出す。取り出すと空になる。
 * 宛先が違う・期限切れの場合は何も返さない（期限切れは破棄する）。
 */
export function takePdfHandoff(targetToolId: string, now: number = Date.now()): PdfHandoff | null {
  const current = pending;
  if (!current) return null;
  if (now - current.offeredAt > PDF_HANDOFF_TTL_MS) {
    pending = null;
    return null;
  }
  if (current.targetToolId !== targetToolId) return null;
  pending = null;
  return current;
}

/** 受け取り前の引き継ぎを破棄する（テストや、引き継ぎ元が取り消したいときに使う） */
export function clearPdfHandoff(): void {
  pending = null;
}

/** いま引き継ぎが置かれているか（中身は返さない。テスト用） */
export function hasPendingPdfHandoff(): boolean {
  return pending !== null;
}

/**
 * 引き継がれたファイルを、ファイル選択と同じ基準で確認する。問題があれば利用者向けの短いメッセージを返す。
 */
export function validateHandoffFile(file: File): string | null {
  const name = file.name.toLowerCase();
  const isPdf = file.type === "application/pdf" || name.endsWith(".pdf");
  if (!isPdf) {
    return `引き継いだファイルがPDFではありません（${file.name}）。PDFを選び直してください。`;
  }
  if (file.size === 0) {
    return "引き継いだファイルが空でした。PDFを選び直してください。";
  }
  if (file.size > PDF_HANDOFF_MAX_SIZE_MB * 1024 * 1024) {
    return `引き継いだファイルが${PDF_HANDOFF_MAX_SIZE_MB}MBを超えています（${file.name}）。${PDF_HANDOFF_MAX_SIZE_MB}MB以下のPDFを選び直してください。`;
  }
  return null;
}

/** 処理結果のBlobを、引き継ぎ用のFileにする（ファイル名は、ダウンロード時と同じ名前を保つ） */
export function pdfBlobToFile(blob: Blob, fileName: string): File {
  return new File([blob], fileName, { type: "application/pdf", lastModified: Date.now() });
}
