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
