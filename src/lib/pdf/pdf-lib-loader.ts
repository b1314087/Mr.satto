import type * as PdfLibModule from "pdf-lib";

/**
 * PDFを作る部品（pdf-lib・日本語フォントを扱う fontkit）を、使うときに初めて読み込む（ロードマップC 工程2）。
 *
 * 以前は、PDFを作るツールのページを開いただけで、この2つ（圧縮後で合わせて約480KB）を読み込んでいた。
 * 今は、PDFを作る・読む処理を始めるとき（ensurePdfLib を呼んだとき）に読み込み、2回目からは読み込み済みのものを使う。
 * 作るPDFの中身・フォントの入れ方は、以前とまったく同じ（同じ部品を、読み込む時期だけ遅らせている）。
 *
 * 使い方：処理の入口（async の関数）で `await ensurePdfLib()` を呼び、そのあと `pdfLib().PDFDocument` のように使う。
 * 日本語フォントを入れる処理では `await ensurePdfLib({ fontkit: true })` とし、`fontkitLib()` を registerFontkit に渡す。
 */

type Fontkit = Parameters<PdfLibModule.PDFDocument["registerFontkit"]>[0];

let lib: typeof PdfLibModule | null = null;
let libPromise: Promise<typeof PdfLibModule> | null = null;
let fontkit: Fontkit | null = null;
let fontkitPromise: Promise<Fontkit> | null = null;

export async function ensurePdfLib(options: { fontkit?: boolean } = {}): Promise<void> {
  if (!lib) {
    libPromise ??= import("pdf-lib");
    try {
      lib = await libPromise;
    } catch (e) {
      // 通信の失敗などで読み込めなかったときは、次に押したときにもう一度読み込めるようにする
      libPromise = null;
      throw new Error("PDFを作る部品を読み込めませんでした。通信の状態を確かめて、もう一度お試しください。", { cause: e });
    }
  }
  if (options.fontkit && !fontkit) {
    fontkitPromise ??= import("@pdf-lib/fontkit").then((m) => m.default as unknown as Fontkit);
    try {
      fontkit = await fontkitPromise;
    } catch (e) {
      fontkitPromise = null;
      throw new Error("日本語フォントを扱う部品を読み込めませんでした。通信の状態を確かめて、もう一度お試しください。", { cause: e });
    }
  }
}

/** 読み込み済みの pdf-lib。ensurePdfLib() のあとに使う */
export function pdfLib(): typeof PdfLibModule {
  if (!lib) throw new Error("PDFを作る部品の準備ができていません。もう一度お試しください。");
  return lib;
}

/** 読み込み済みの fontkit。ensurePdfLib({ fontkit: true }) のあとに使う */
export function fontkitLib(): Fontkit {
  if (!fontkit) throw new Error("日本語フォントを扱う部品の準備ができていません。もう一度お試しください。");
  return fontkit;
}

/** pdf-lib が読み込み済みか（同期的に使う処理で、確かめるため） */
export function isPdfLibLoaded(): boolean {
  return lib !== null;
}
