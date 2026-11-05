/**
 * 差し込み印刷・レイアウト作成：画面のプレビューで使うフォント。
 * PDFの出力と同じフォントファイル（Noto Sans JP・Noto Serif JP）を、
 * ① pdf-lib で読み込んで文字の幅を測る（PDFと同じ幅で折り返し・揃えを計算する）
 * ② ブラウザにも登録して、プレビューの文字を同じ形で描く
 * どちらも同じサイトの中のフォントファイルを読むだけで、ファイルをどこかへ送ることはない。
 * 明朝体は約3MBあるため、明朝体の項目を作ったときに初めて読み込む。
 */
import type { PDFFont } from "pdf-lib";
import { loadJapaneseFontBytes, loadJapaneseSerifFontBytes } from "@/lib/pdf/japanese-font";
import { ensurePdfLib, fontkitLib, pdfLib } from "@/lib/pdf/pdf-lib-loader";
import type { FontId, MeasureFn } from "./layout";

export const PREVIEW_FONT_FAMILY: Record<FontId, string> = {
  gothic: "MailMergeNotoSansJP",
  mincho: "MailMergeNotoSerifJP",
};

const cache = new Map<FontId, Promise<PDFFont>>();

/** 文字の幅を測るためのフォント（同時に、プレビュー用のフォントもブラウザに登録する） */
export function loadMeasureFont(id: FontId): Promise<PDFFont> {
  let p = cache.get(id);
  if (!p) {
    p = (async () => {
      await ensurePdfLib({ fontkit: true });
      const bytes = id === "mincho" ? await loadJapaneseSerifFontBytes() : await loadJapaneseFontBytes();
      const face = new FontFace(PREVIEW_FONT_FAMILY[id], new Uint8Array(bytes));
      await face.load();
      document.fonts.add(face);
      const doc = await pdfLib().PDFDocument.create();
      doc.registerFontkit(fontkitLib());
      return doc.embedFont(new Uint8Array(bytes), { subset: false });
    })().catch((e) => {
      cache.delete(id);
      throw e;
    });
    cache.set(id, p);
  }
  return p;
}

/** 読み込んだフォントで、文字の幅を測る関数を作る（明朝体がまだなら、ゴシック体の幅で代わりに測る） */
export function makeMeasure(fonts: Partial<Record<FontId, PDFFont>>): MeasureFn {
  return (text, font, size) => {
    const f = fonts[font] ?? fonts.gothic;
    if (!f || text === "") return 0;
    try {
      return f.widthOfTextAtSize(text, size);
    } catch {
      return text.length * size;
    }
  };
}
