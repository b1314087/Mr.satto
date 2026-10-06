/**
 * プレビュー専用の文字幅の近似。PDF側は埋め込みフォントの実測幅で折り返すが、
 * プレビューではフォントを読み込まないため、全角=1、半角英数=約0.55 として推定する。
 */
export function approxWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of Array.from(text)) w += ch.charCodeAt(0) < 0x80 ? size * 0.55 : size;
  return w;
}

export function approxWrap(text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    let current = "";
    for (const ch of Array.from(paragraph)) {
      const candidate = current + ch;
      if (current !== "" && approxWidth(candidate, size) > maxWidth) {
        lines.push(current);
        current = ch;
      } else {
        current = candidate;
      }
    }
    if (current !== "") lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}
