import { FORM_MAX_CHARS_TOTAL, FORM_MAX_PAGES } from "@/lib/ai/form-extract";

/**
 * Word→Excelの「AIで表にする」補助（プレミアム）で、AIへ送る文章のまとまりを作る（純粋な処理）。
 * - 表以外の段落を、文書の順のまま、最大 FORM_MAX_PAGES 個のまとまりに分ける（段落の途中では切らない）。
 * - 送れる文字数（FORM_MAX_CHARS_TOTAL）を超えるときは、送らずに理由を返す。
 */
export type WordAiChunks =
  | { ok: true; pages: { page: number; text: string }[]; chars: number; paragraphs: number }
  | { ok: false; reason: "empty" | "too_long"; chars: number };

export function chunkWordParagraphsForAi(paragraphs: string[], maxChunks = FORM_MAX_PAGES, maxChars = FORM_MAX_CHARS_TOTAL): WordAiChunks {
  const list = paragraphs.map((p) => p.replace(/\r\n?/g, "\n").trim()).filter((p) => p !== "");
  if (list.length === 0) return { ok: false, reason: "empty", chars: 0 };
  // まとまりの中は改行でつなぐ（その改行の分も、送る文字数に数える）
  const total = list.reduce((n, p) => n + p.length, 0) + Math.max(0, list.length - 1);
  if (total > maxChars) return { ok: false, reason: "too_long", chars: total };

  const target = Math.max(1, Math.ceil(total / maxChunks));
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const p of list) {
    current.push(p);
    size += p.length + 1;
    if (size >= target) {
      chunks.push(current);
      current = [];
      size = 0;
    }
  }
  if (current.length > 0) chunks.push(current);
  while (chunks.length > maxChunks) {
    const last = chunks.pop() as string[];
    chunks[chunks.length - 1].push(...last);
  }
  const pages = chunks.map((c, i) => ({ page: i + 1, text: c.join("\n") }));
  return { ok: true, pages, chars: pages.reduce((n, p) => n + p.text.length, 0), paragraphs: list.length };
}
