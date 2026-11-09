/**
 * PDFのページの文字情報(テキストレイヤー)を、読みやすいテキストに組み立てる(工程4：PDF→テキストの改善)。
 *
 * - 文字の並びは、PDFに書かれている順番(多くのPDFで読む順番。段組みも段ごとに続く)をそのまま使う。
 * - 行の終わり(hasEOL)や、次の文字が別の行にあるときは改行する。
 * - 行と行の間が大きく空いているところ(段落の切れ目)は、空行を1行入れる。
 * - 同じ行の中では、日本語の文字どうしの間に余計な空白を入れない(英数字の単語の間、表の列のように大きく離れた
 *   ところだけ空白を入れる)。
 * - 縦書きの文字(上から下へ続く文字)は、1文字ずつ改行せずにつなげる。
 *
 * 位置を使うのは、改行・空白・空行の判断だけ(文字の並べ替えはしない)。ブラウザの中だけで完結する。
 */

export interface PageTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height?: number;
  fontHeight: number;
  hasEOL: boolean;
}

const CJK_RE = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

function isCjk(ch: string | undefined): boolean {
  return !!ch && CJK_RE.test(ch);
}

/** ページの文字情報から、改行・段落を残したテキストを作る */
export function pageTextFromItems(items: readonly PageTextItem[]): string {
  let out = "";
  let prev: PageTextItem | null = null;
  let pendingEol = false;
  for (const it of items) {
    if (it.str === "") {
      // 中身のない項目は「行の終わり」の印として使うことが多い
      if (it.hasEOL && prev) pendingEol = true;
      continue;
    }
    if (prev) {
      const lh = Math.max(prev.fontHeight, it.fontHeight, 1);
      const dy = prev.y - it.y; // 次の文字が下にあるとき正
      const dx = it.x - (prev.x + prev.width);
      const sameRow = Math.abs(dy) < lh * 0.5;
      // 縦書き：横の位置がほぼ同じで、すぐ下に続く
      const vertical = !sameRow && Math.abs(it.x - prev.x) < lh * 0.5 && dy > 0 && dy < lh * 3 && (prev.width < lh * 1.5 || it.width < lh * 1.5);
      if (pendingEol || prev.hasEOL || (!sameRow && !vertical)) {
        // 行が変わる。行と行の間が大きく空いていたら段落の切れ目として空行を入れる
        out += !sameRow && Math.abs(dy) > lh * 1.9 ? "\n\n" : "\n";
      } else if (sameRow) {
        const last = prev.str[prev.str.length - 1];
        const first = it.str[0];
        const cjkJoin = isCjk(last) || isCjk(first);
        const needsSpace = cjkJoin ? dx > lh * 1.0 : dx > lh * 0.15;
        if (needsSpace && !/\s$/.test(prev.str) && !/^\s/.test(it.str)) out += " ";
      }
    }
    out += it.str;
    prev = it;
    pendingEol = false;
  }
  return out
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
