import type * as MediabunnyModule from "mediabunny";

/**
 * 動画・音声の部品（mediabunny）を、使うときに初めて読み込む（ロードマップC 工程4）。
 *
 * 以前は、動画・音声のページを開いただけで、この部品（圧縮後で約120KB）を読み込んでいた。
 * 今は、ファイルを選んで、動画・音声の情報を読む・変換する処理を始めるとき（ensureMediabunny を呼んだとき）に読み込み、
 * 2回目からは読み込み済みのものを使う。処理の内容は以前とまったく同じ（読み込む時期だけ遅らせている）。
 * PDFの部品（pdf-lib-loader.ts）と同じ仕組み。
 *
 * 使い方：処理の入口（async の関数）で `await ensureMediabunny()` を呼び、そのあと `mediabunny().Input` のように使う。
 */

let lib: typeof MediabunnyModule | null = null;
let libPromise: Promise<typeof MediabunnyModule> | null = null;

export async function ensureMediabunny(): Promise<void> {
  if (lib) return;
  libPromise ??= import("mediabunny");
  try {
    lib = await libPromise;
  } catch (e) {
    // 通信の失敗などで読み込めなかったときは、次にもう一度読み込めるようにする
    libPromise = null;
    throw new Error("動画・音声を扱う部品を読み込めませんでした。通信の状態を確かめて、もう一度お試しください。", { cause: e });
  }
}

/** 読み込み済みの mediabunny。ensureMediabunny() のあとに使う */
export function mediabunny(): typeof MediabunnyModule {
  if (!lib) throw new Error("動画・音声を扱う部品の準備ができていません。もう一度お試しください。");
  return lib;
}
