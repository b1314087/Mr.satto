/**
 * 「1,3,5-7」のようなページ指定文字列を解析する共通ユーティリティ（Phase 6）。
 *
 * PDFページ抽出ツールが使う。将来ページ指定UIを持つ他のPDFツールが
 * 追加された場合も、この関数を再利用できるよう独立したモジュールにしている。
 *
 * 仕様（Phase 6 spec 7章）:
 * - カンマ区切りで個別ページ・範囲（開始-終了）を混在指定できる
 * - 前後の空白は許容する
 * - 0ページ・範囲外ページ・逆順範囲（例: 7-5）・不正な文字列・重複指定は
 *   すべてエラーとする（不正な結果を黙って生成しない）
 * - ページの並び順は、ユーザーが指定した順序をそのまま使う
 *   （例: "5,2,4" なら 5→2→4 の順で出力する）
 */
export function parsePageSelection(input: string, totalPages: number): number[] {
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new Error("抽出するページを指定してください（例: 1,3,5-7）");
  }

  const tokens = trimmed
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  if (tokens.length === 0) {
    throw new Error("抽出するページを指定してください（例: 1,3,5-7）");
  }

  const pages: number[] = [];
  const seen = new Set<number>();

  function addPage(p: number, label: string) {
    if (p < 1) {
      throw new Error(`ページ指定が正しくありません（${label}）。1以上のページ番号を指定してください。`);
    }
    if (p > totalPages) {
      throw new Error(
        `存在しないページが指定されています（${label}）。このPDFは全${totalPages}ページです。`
      );
    }
    if (seen.has(p)) {
      throw new Error(
        `ページ${p}が複数回指定されています。重複を取り除いてから再度指定してください。`
      );
    }
    seen.add(p);
    pages.push(p);
  }

  for (const token of tokens) {
    const rangeMatch = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (end < start) {
        throw new Error(
          `ページ範囲の順序が正しくありません（${token}）。開始ページは終了ページ以下にしてください。`
        );
      }
      for (let p = start; p <= end; p++) {
        addPage(p, token);
      }
      continue;
    }

    if (!/^\d+$/.test(token)) {
      throw new Error(
        `ページ指定の形式が正しくありません（${token}）。「1,3,5-7」のように指定してください。`
      );
    }
    addPage(Number(token), token);
  }

  return pages;
}
