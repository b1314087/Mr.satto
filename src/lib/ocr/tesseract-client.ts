import type { Worker } from "tesseract.js";

/**
 * OCR基盤（Phase 2-D ■OCR）。
 *
 * tesseract.js は「ブラウザで動くから」という単純な理由ではなく、
 * 実際に以下を検討したうえでBrowserProcessorとして採用している
 * （詳細は最終報告の【2. アーキテクチャ】を参照）：
 *   - Vercel Hobby プランのサーバー関数は実行時間が60秒に制限されており、
 *     OCR処理の途中で打ち切られるリスクがある
 *   - サーバーで実行する場合でも、外部の有償OCR SaaS（Google Cloud Vision等）
 *     は今回のフェーズで導入禁止のため、結局同じ tesseract.js(WASM) を
 *     使うことになり、サーバー実行の優位性が薄い
 *   - サーバーはリクエストの度にWASM＋学習データ（数MB〜十数MB）を
 *     再取得・再初期化するコストがあるが、ブラウザはセッション中
 *     再利用できる
 *
 * モデル・WASM本体はアプリのJSバンドルに含めず、public/tesseract/ 配下に
 * 自前ホストした静的ファイルとして必要になった時点でのみ取得する
 * （jsdelivr等の外部CDN既定パスは、このプロジェクトの実行環境からは
 * 到達できないため利用していない）。
 *
 * 今回ダウンロードして自前配置したコアは LSTM専用（fast, 量子化）モデルの
 * ため、OEM（OCR Engine Mode）は明示的に 1 = LSTM_ONLY を指定する
 * （既定値の DEFAULT=3 は legacy+LSTM 混在エンジン用の学習データを
 *  要求するため、今回自前配置したデータとは一致しない）。
 */

const WORKER_PATH = "/tesseract/worker.min.js";
const CORE_PATH = "/tesseract/core";
const LANG_PATH = "/tesseract/lang-data";
const OEM_LSTM_ONLY = 1;

/** UI側で選ばせる言語オプション。tesseract.js の言語コードへは toTesseractLangCode() で変換する */
export type OcrLanguageOption = "ja" | "en" | "ja+en";

export function toTesseractLangCode(option: OcrLanguageOption): string {
  switch (option) {
    case "ja":
      return "jpn";
    case "en":
      return "eng";
    case "ja+en":
      return "jpn+eng";
  }
}

export interface OcrProgress {
  status: string;
  /** 0〜1 */
  progress: number;
}

let workerPromise: Promise<Worker> | null = null;
let workerLangCode: string | null = null;
/**
 * tesseract.js は logger を createWorker() 時にしか登録できないため、
 * Workerを使い回しつつ呼び出し（ページ）ごとに進捗コールバックを
 * 差し替えられるよう、実際に呼ばれるコールバックを間接参照にしておく。
 */
let currentProgressCallback: ((progress: OcrProgress) => void) | null = null;

/**
 * 指定言語のWorkerを取得する（同じ言語であれば使い回す＝再初期化コストを避ける）。
 * 言語が変わった場合は既存Workerを終了してから作り直す。
 */
async function getWorker(langCode: string): Promise<Worker> {
  if (workerPromise && workerLangCode === langCode) {
    return workerPromise;
  }
  if (workerPromise) {
    const stale = workerPromise;
    workerPromise = null;
    workerLangCode = null;
    try {
      const old = await stale;
      await old.terminate();
    } catch {
      // 既存Workerの終了失敗は無視して続行する
    }
  }

  workerLangCode = langCode;
  workerPromise = (async () => {
    const { createWorker } = await import("tesseract.js");
    return createWorker(langCode, OEM_LSTM_ONLY, {
      workerPath: WORKER_PATH,
      corePath: CORE_PATH,
      langPath: LANG_PATH,
      // gzip圧縮した学習データ（*.traineddata.gz）を自前配置しているため、
      // tesseract.js の既定動作（gzip:true）に合わせる
      gzip: true,
      logger: (m) => {
        currentProgressCallback?.({ status: m.status, progress: m.progress });
      },
    });
  })();
  return workerPromise;
}

export interface OcrRecognizeResult {
  text: string;
  /** tesseract.js が返す信頼度（0〜100） */
  confidence: number;
}

/**
 * 画像（またはCanvas）1枚をOCR処理する。
 * OCR自体は完全な精度を保証しない（画像品質・文字の状態に依存する）ため、
 * 呼び出し側（UI）はその旨を利用者に案内すること。
 */
export async function recognizeImage(
  image: File | Blob | HTMLCanvasElement | string,
  langOption: OcrLanguageOption,
  onProgress?: (progress: OcrProgress) => void
): Promise<OcrRecognizeResult> {
  const langCode = toTesseractLangCode(langOption);
  const worker = await getWorker(langCode);

  currentProgressCallback = onProgress ?? null;
  try {
    const { data } = await worker.recognize(image, {}, { text: true });
    return { text: data.text ?? "", confidence: data.confidence ?? 0 };
  } finally {
    currentProgressCallback = null;
  }
}

/** OCRで検出した単語1つ分の位置情報（画像のピクセル座標。原点は左上、下方向がy増加） */
export interface OcrWord {
  text: string;
  confidence: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrRecognizeWithWordsResult extends OcrRecognizeResult {
  /** bounding box付きの単語一覧（Phase 11: 記入済みPDF→Excelの座標ベース項目化に使用） */
  words: OcrWord[];
}

/**
 * 画像（またはCanvas）1枚をOCRし、単語ごとのbounding box（座標）も取得する。
 * AIによる項目推定は行わず、この座標情報を使って
 * src/lib/pdf/table-reconstruction.ts の決定的な行・列推定へそのまま渡す
 * （Phase 11 開発指示書 14章：「なんとなくAIが判断」する方式を禁止）。
 *
 * tesseract.jsへ { blocks: true } を指定した場合のみ data.blocks が返る
 * （通常の recognizeImage() は { text: true } のみ要求しており blocks は
 * 取得しない。bounding boxが不要な既存呼び出し元の処理量を増やさないよう、
 * 別関数として分離している）。
 */
export async function recognizeImageWithWords(
  image: File | Blob | HTMLCanvasElement | string,
  langOption: OcrLanguageOption,
  onProgress?: (progress: OcrProgress) => void
): Promise<OcrRecognizeWithWordsResult> {
  const langCode = toTesseractLangCode(langOption);
  const worker = await getWorker(langCode);

  currentProgressCallback = onProgress ?? null;
  try {
    const { data } = await worker.recognize(image, {}, { blocks: true });
    const words: OcrWord[] = [];
    for (const block of data.blocks ?? []) {
      for (const paragraph of block.paragraphs) {
        for (const line of paragraph.lines) {
          for (const word of line.words) {
            const text = word.text.trim();
            if (!text) continue;
            words.push({
              text,
              confidence: word.confidence,
              x0: word.bbox.x0,
              y0: word.bbox.y0,
              x1: word.bbox.x1,
              y1: word.bbox.y1,
            });
          }
        }
      }
    }
    return { text: data.text ?? "", confidence: data.confidence ?? 0, words };
  } finally {
    currentProgressCallback = null;
  }
}

/** OCR用Workerを終了する（キャンセル・後始末用のベストエフォート実装） */
export async function terminateOcrWorker(): Promise<void> {
  if (!workerPromise) return;
  const stale = workerPromise;
  workerPromise = null;
  workerLangCode = null;
  try {
    const worker = await stale;
    await worker.terminate();
  } catch {
    // ignore
  }
}
