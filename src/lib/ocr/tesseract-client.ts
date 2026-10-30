import type { Worker } from "tesseract.js";
import type { PositionedTextItem } from "@/lib/pdf/pdfjs-client";

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
  /** OCRが同じ行と判断した単語には同じ番号が付く(ページ内で一意)。古い呼び出し元・テストでは未指定 */
  lineIndex?: number;
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
  onProgress?: (progress: OcrProgress) => void,
  options: { pageSegMode?: "6" } = {}
): Promise<OcrRecognizeWithWordsResult> {
  const langCode = toTesseractLangCode(langOption);
  const worker = await getWorker(langCode);

  currentProgressCallback = onProgress ?? null;
  // ページ全体を「1つの文字ブロック」として読む(6)と、罫線を消した表の行が安定して読める。
  // Workerは他の呼び出しと共有のため、使い終わったら既定(3=自動)へ戻す。
  const customPsm = options.pageSegMode;
  try {
    if (customPsm) await worker.setParameters({ tessedit_pageseg_mode: customPsm as never });
    const { data } = await worker.recognize(image, {}, { blocks: true });
    const words: OcrWord[] = [];
    let lineIndex = 0;
    for (const block of data.blocks ?? []) {
      for (const paragraph of block.paragraphs) {
        for (const line of paragraph.lines) {
          lineIndex++;
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
              lineIndex,
            });
          }
        }
      }
    }
    return { text: data.text ?? "", confidence: data.confidence ?? 0, words };
  } finally {
    currentProgressCallback = null;
    if (customPsm) {
      try {
        await worker.setParameters({ tessedit_pageseg_mode: "3" as never });
      } catch {
        // 戻せなくても致命的ではない(次回の呼び出しで再設定される)
      }
    }
  }
}

/**
 * OCRの単語（画像ピクセル座標、原点は左上・下方向がy増加）を、
 * table-reconstruction.ts / paragraph-reconstruction.ts が期待する
 * PositionedTextItem 形状（行のグルーピングは「上ほど大きいy」を前提にしている）へ
 * 変換する共通ヘルパー。元々は記入済みPDF→Excel(filled-pdf-to-excel.ts)専用の
 * ローカル関数だったが、PDF→Word(pdf-to-word.ts)のスキャンPDF対応
 * （外出先PC修正指示書§27-28）でも全く同じ変換が必要になったため、OCR基盤
 * （このファイル）へ共通化した（開発指示書■21の「共通のPDF解析基盤として集約する」
 * 方針を踏襲）。ページごとに単独で使う値のため、PDFの実座標系と一致させる必要はなく、
 * 「同じページ内で一貫している」ことだけが重要。
 */
export function ocrWordsToPositionedTextItems(rawWords: OcrWord[]): PositionedTextItem[] {
  const words = rawWords.map((w) => {
    const fixed = fixOcrThousandsSeparator(w.text);
    return fixed === w.text ? w : { ...w, text: fixed };
  });
  const byLine = new Map<number, OcrWord[]>();
  const loose: OcrWord[] = [];
  for (const w of words) {
    if (w.lineIndex === undefined) {
      loose.push(w);
      continue;
    }
    const list = byLine.get(w.lineIndex);
    if (list) list.push(w);
    else byLine.set(w.lineIndex, [w]);
  }

  const toItem = (w: OcrWord, y: number, height: number): PositionedTextItem => ({
    str: w.text,
    x: w.x0,
    y,
    width: Math.max(0, w.x1 - w.x0),
    height: Math.max(1, height),
    fontHeight: Math.max(1, height),
    hasEOL: false,
  });

  // 行の情報がない単語は、従来どおり単語ごとの位置をそのまま使う
  const items: PositionedTextItem[] = loose.map((w) => toItem(w, -w.y0, w.y1 - w.y0));

  for (const lineWords of byLine.values()) {
    // OCRは1つの行の中でも、文字の形(数字・かな・漢字・濁点など)によって単語の上端や高さが
    // ばらつく。そのまま使うと、同じ行の電話番号や住所だけが「別の行」と判定され、
    // 表の1行が2行に割れてしまう。そこで同じ行の単語は、行の代表値(中央値)の
    // 縦位置・高さに揃える。
    const sorted = [...lineWords].sort((a, b) => a.x0 - b.x0);
    const heights = sorted.map((w) => w.y1 - w.y0);
    const centers = sorted.map((w) => (w.y0 + w.y1) / 2);
    const lineHeight = Math.max(1, medianOf(heights));
    const lineCenter = medianOf(centers);

    // 日本語は単語の間に空白を入れない言語だが、OCRは文字の間に細い隙間があると
    // 単語を分けてしまう(「ヤマダ タ ロウ」「フリ ガ ナ」など)。
    // 日本語の文字同士で、隙間が文字の高さの半分以下のものは1つの単語につなぐ。
    const merged: OcrWord[] = [];
    for (const w of sorted) {
      const prev = merged[merged.length - 1];
      if (prev && canJoinJapanese(prev.text, w.text) && w.x0 - prev.x1 < lineHeight * 0.5) {
        merged[merged.length - 1] = { ...prev, text: prev.text + w.text, x1: Math.max(prev.x1, w.x1) };
      } else {
        merged.push(w);
      }
    }
    for (const w of merged) items.push(toItem(w, -lineCenter, lineHeight));
  }
  return items;
}

/**
 * OCRは、3桁区切りのカンマ「,」をピリオド「.」と読み違えることが多い(「1,980」→「1.980」)。
 * このまま表にすると「1.98」という小数の数値になり、桁がずれて値が変わってしまう。
 * 日本語の帳票では「小数点以下がちょうど3桁」の小数はほとんど無く、3桁区切りのほうが
 * はるかに多いので、「1〜3桁.3桁(.3桁…)」の形の数字(円・¥付きを含む)は区切りのカンマに直す。
 * 0から始まる「0.500」は小数として確実なので直さない。
 */
export function fixOcrThousandsSeparator(text: string): string {
  const m = text.match(/^([¥￥$]?)(\d{1,3}(?:\.\d{3})+)(円?)$/);
  if (!m || m[2].startsWith("0.")) return text;
  return `${m[1]}${m[2].replace(/\./g, ",")}${m[3]}`;
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ひらがな・カタカナ・漢字(全角のもの)。半角カナ・英数字・記号は含めない
const CJK_CHAR_RE = /[\u3041-\u30ff\u3400-\u9fff\uf900-\ufaff]/;
const DIGIT_RE = /[0-9０-９]/;
/**
 * 2つの単語を空白なしでつないでよいか。境目の文字が両方とも「日本語の文字か数字」で、
 * 少なくとも片方が日本語の文字のとき(「令和8」+「年」、「東京」+「都」など)。
 * 数字同士(別々の数値の列)や英数字同士はつながない。
 */
function canJoinJapanese(left: string, right: string): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const a = left[left.length - 1];
  const b = right[0];
  const aCjk = CJK_CHAR_RE.test(a);
  const bCjk = CJK_CHAR_RE.test(b);
  if (aCjk && bCjk) return true;
  return (aCjk && DIGIT_RE.test(b)) || (bCjk && DIGIT_RE.test(a));
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
