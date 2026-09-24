import { BrowserProcessor } from "../types";

export interface CharCountInput {
  text: string;
}

export interface CharCountOutput {
  characters: number;
  charactersNoSpaces: number;
  words: number;
  lines: number;
  bytes: number;
}

export class CharCountProcessor extends BrowserProcessor<CharCountInput, CharCountOutput> {
  async process({ text }: CharCountInput) {
    const characters = Array.from(text).length;
    const charactersNoSpaces = Array.from(text.replace(/\s/g, "")).length;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const lines = text === "" ? 0 : text.split(/\r\n|\r|\n/).length;
    const bytes = new TextEncoder().encode(text).length;
    return { characters, charactersNoSpaces, words, lines, bytes };
  }
}

// ---------------------------------------------------------------------------
// JSON整形
// ---------------------------------------------------------------------------
export interface JsonFormatInput {
  text: string;
  indent: number;
  minify?: boolean;
}

export interface JsonFormatOutput {
  formatted: string;
}

export class JsonFormatProcessor extends BrowserProcessor<JsonFormatInput, JsonFormatOutput> {
  async process({ text, indent, minify }: JsonFormatInput) {
    if (!text.trim()) {
      throw new Error("JSON文字列を入力してください");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("JSONの形式が正しくありません。構文を確認してください。");
    }
    const formatted = minify
      ? JSON.stringify(parsed)
      : JSON.stringify(parsed, null, indent);
    return { formatted };
  }
}

// ---------------------------------------------------------------------------
// CSV整形
// ---------------------------------------------------------------------------
export interface CsvFormatInput {
  text: string;
  trimCells: boolean;
  removeEmptyLines: boolean;
}

export interface CsvFormatOutput {
  formatted: string;
  rowCount: number;
}

export class CsvFormatProcessor extends BrowserProcessor<CsvFormatInput, CsvFormatOutput> {
  async process({ text, trimCells, removeEmptyLines }: CsvFormatInput) {
    if (!text.trim()) {
      throw new Error("CSVの内容を入力してください");
    }

    let lines = text.split(/\r\n|\r|\n/);

    if (removeEmptyLines) {
      lines = lines.filter((line) => line.trim() !== "");
    }

    const processedLines = lines.map((line) => {
      if (!trimCells) return line;
      return line
        .split(",")
        .map((cell) => cell.trim())
        .join(",");
    });

    return {
      formatted: processedLines.join("\n"),
      rowCount: processedLines.length,
    };
  }
}

// ---------------------------------------------------------------------------
// テキスト行整理（Phase 6）
// ---------------------------------------------------------------------------
export type TextLineSort = "none" | "asc" | "desc";

export interface TextLineCleanerInput {
  text: string;
  removeEmptyLines: boolean;
  trimLines: boolean;
  collapseSpaces: boolean;
  dedupeLines: boolean;
  sort: TextLineSort;
}

export interface TextLineCleanerOutput {
  result: string;
  lineCountBefore: number;
  lineCountAfter: number;
}

/**
 * 各処理項目（空行削除・行頭行末空白削除・連続スペース整理・重複行削除・ソート）を
 * それぞれ個別にON/OFFできるようにし、ユーザーが選んでいない処理は行わない
 * （意図しないデータ変更を避ける。Phase 6 spec 16章）。
 * 昇順/降順ソートは同時に両立しない状態のため、1つの sort 値（"none"|"asc"|"desc"）
 * として扱う（UI側でもラジオボタン相当の排他選択にする）。
 */
export class TextLineCleanerProcessor extends BrowserProcessor<
  TextLineCleanerInput,
  TextLineCleanerOutput
> {
  async process({
    text,
    removeEmptyLines,
    trimLines,
    collapseSpaces,
    dedupeLines,
    sort,
  }: TextLineCleanerInput) {
    if (!text.trim()) {
      throw new Error("テキストを入力してください");
    }

    let lines = text.split(/\r\n|\r|\n/);
    const lineCountBefore = lines.length;

    if (trimLines) {
      lines = lines.map((line) => line.trim());
    }
    if (collapseSpaces) {
      lines = lines.map((line) => line.replace(/[ \t]{2,}/g, " "));
    }
    if (removeEmptyLines) {
      lines = lines.filter((line) => line.trim() !== "");
    }
    if (dedupeLines) {
      const seen = new Set<string>();
      lines = lines.filter((line) => {
        if (seen.has(line)) return false;
        seen.add(line);
        return true;
      });
    }
    if (sort === "asc") {
      lines = [...lines].sort((a, b) => a.localeCompare(b, "ja"));
    } else if (sort === "desc") {
      lines = [...lines].sort((a, b) => b.localeCompare(a, "ja"));
    }

    return {
      result: lines.join("\n"),
      lineCountBefore,
      lineCountAfter: lines.length,
    };
  }
}
