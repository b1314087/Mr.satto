import { BrowserProcessor } from "../types";
import {
  loadDocxPackage,
  parseDocumentXml,
  serializeDocumentXml,
  buildDocxBlob,
  getBodyElement,
  getTopLevelParagraphs,
  getParagraphText,
} from "@/lib/word/docx-text-ops";

/**
 * Word番号振り直し（次工程・軽量便利ツール一括追加 Tool 10）。
 *
 * 対象は「段落の先頭が単純なテキストの番号表記になっている」もの限定
 * （"1." "(1)" "①" "ア" など）。Wordの本来の自動採番機能（w:numPr・
 * リストのアウトライン構造）には一切手を付けない・変換もしない
 * （指示書が明示的に除外している「複雑なWord自動採番の変換」に該当するため）。
 *
 * 安全のため、番号マーカーが1つのテキストラン(w:t)の先頭に完全に
 * 収まっている段落だけを変換対象にする。書式の都合でマーカーが複数の
 * ラン（例: 太字の"1"と通常の"."が別ラン）に分かれている場合は、
 * 誤ってテキストの意味を壊さないよう変換をスキップする
 * （本文そのものは絶対に変更しない、という指示を最優先する）。
 * また、本文直下の段落のみを対象にする（表のセル内は対象外）。
 */
export type NumberingFormat = "arabic-dot" | "paren" | "circled" | "katakana";

export interface WordRenumberInput {
  file: File;
  sourceFormat: NumberingFormat;
  targetFormat: NumberingFormat;
}

export interface WordRenumberOutput {
  blob: Blob;
  convertedCount: number;
  skippedCount: number;
}

const CIRCLED_DIGITS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"];

// 五十音順（「ん」を除く、伊呂波ではなく実用的な五十音順）を使った、
// 日本語文書でよく使われる箇条書き用のカタカナ連番
const KATAKANA_SEQUENCE = [
  "ア", "イ", "ウ", "エ", "オ", "カ", "キ", "ク", "ケ", "コ",
  "サ", "シ", "ス", "セ", "ソ", "タ", "チ", "ツ", "テ", "ト",
  "ナ", "ニ", "ヌ", "ネ", "ノ", "ハ", "ヒ", "フ", "ヘ", "ホ",
  "マ", "ミ", "ム", "メ", "モ", "ヤ", "ユ", "ヨ", "ラ", "リ",
  "ル", "レ", "ロ", "ワ", "ヲ",
];

interface FormatHandler {
  /** 段落先頭のテキストランからマーカーを検出し、番号Nとマッチした文字列を返す */
  detect(text: string): { n: number; matched: string } | null;
  /** 番号Nをこの形式のマーカー文字列として描画する（対応範囲外はnull） */
  render(n: number): string | null;
}

const HANDLERS: Record<NumberingFormat, FormatHandler> = {
  "arabic-dot": {
    detect(text) {
      const m = /^(\d{1,3})\.(?!\d)/.exec(text);
      if (!m) return null;
      return { n: Number(m[1]), matched: m[0] };
    },
    render(n) {
      return `${n}.`;
    },
  },
  paren: {
    detect(text) {
      const m = /^\((\d{1,3})\)/.exec(text);
      if (!m) return null;
      return { n: Number(m[1]), matched: m[0] };
    },
    render(n) {
      return `(${n})`;
    },
  },
  circled: {
    detect(text) {
      const ch = text.charAt(0);
      const idx = CIRCLED_DIGITS.indexOf(ch);
      if (idx === -1) return null;
      return { n: idx + 1, matched: ch };
    },
    render(n) {
      return n >= 1 && n <= CIRCLED_DIGITS.length ? CIRCLED_DIGITS[n - 1] : null;
    },
  },
  katakana: {
    detect(text) {
      const ch = text.charAt(0);
      const idx = KATAKANA_SEQUENCE.indexOf(ch);
      if (idx === -1) return null;
      return { n: idx + 1, matched: ch };
    },
    render(n) {
      return n >= 1 && n <= KATAKANA_SEQUENCE.length ? KATAKANA_SEQUENCE[n - 1] : null;
    },
  },
};

/** 番号形式の組み合わせが正しいか検証する(出力とプレビューで共通) */
function getHandlers(source: NumberingFormat, target: NumberingFormat) {
  const sourceHandler = HANDLERS[source];
  const targetHandler = HANDLERS[target];
  if (!sourceHandler || !targetHandler) {
    throw new Error("変換元・変換先の形式を選択してください");
  }
  return { sourceHandler, targetHandler };
}

/**
 * 解析済みのdocument.xml(DOM)の段落先頭の番号を振り直す(出力とプレビューで共通)。
 * doc は直接書き換えられる。paragraphs は本文直下の段落ごとの「処理前/処理後テキスト」と変換有無。
 */
export function applyRenumber(
  doc: Document,
  source: NumberingFormat,
  target: NumberingFormat
): {
  convertedCount: number;
  skippedCount: number;
  paragraphs: { before: string; after: string; converted: boolean }[];
} {
  const { sourceHandler, targetHandler } = getHandlers(source, target);
  const body = getBodyElement(doc);
  const paragraphs = getTopLevelParagraphs(body);
  const beforeTexts = paragraphs.map((p) => getParagraphText(p));
  const convertedFlags: boolean[] = [];

  let convertedCount = 0;
  let skippedCount = 0;

  for (const p of paragraphs) {
    const runs = Array.from(p.getElementsByTagName("w:t"));
    const firstRun = runs.find((r) => (r.textContent ?? "") !== "");
    if (!firstRun) {
      convertedFlags.push(false);
      continue;
    }

    const text = firstRun.textContent ?? "";
    const detected = sourceHandler.detect(text);
    if (!detected) {
      // このパターンにマッチしない段落（本文段落など）は変換対象外として数える
      skippedCount++;
      convertedFlags.push(false);
      continue;
    }

    const rendered = targetHandler.render(detected.n);
    if (rendered === null) {
      // 対応範囲外（例: 丸数字は21以上に対応する文字が無い）。本文を壊さないため変更しない
      skippedCount++;
      convertedFlags.push(false);
      continue;
    }

    firstRun.textContent = rendered + text.slice(detected.matched.length);
    convertedCount++;
    convertedFlags.push(true);
  }

  return {
    convertedCount,
    skippedCount,
    paragraphs: paragraphs.map((p, i) => ({
      before: beforeTexts[i],
      after: getParagraphText(p),
      converted: convertedFlags[i],
    })),
  };
}

/** document.xmlのテキストから、番号を振り直した後の段落テキストを求める(プレビュー用) */
export function previewRenumber(documentXmlText: string, source: NumberingFormat, target: NumberingFormat) {
  return applyRenumber(parseDocumentXml(documentXmlText), source, target);
}

export class WordRenumberProcessor extends BrowserProcessor<WordRenumberInput, WordRenumberOutput> {
  async process(input: WordRenumberInput): Promise<WordRenumberOutput> {
    getHandlers(input.sourceFormat, input.targetFormat);

    const pkg = await loadDocxPackage(input.file);
    const doc = parseDocumentXml(pkg.documentXmlText);
    const { convertedCount, skippedCount } = applyRenumber(doc, input.sourceFormat, input.targetFormat);

    const newXml = serializeDocumentXml(doc, pkg.xmlDeclaration);
    const blob = buildDocxBlob(pkg, newXml);

    return { blob, convertedCount, skippedCount };
  }
}
