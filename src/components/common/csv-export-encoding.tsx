"use client";

import { useState, type ReactNode } from "react";
import {
  CSV_EXPORT_ENCODINGS,
  csvBlobToText,
  csvTextToBlob,
  findUnencodable,
  type CsvExportEncoding,
  type UnencodableChar,
} from "@/lib/utils/csv-export-encoding";
import { downloadBlob } from "@/lib/utils/format";

/** 画面に出す文字（見えない文字・空白は、名前で出す） */
function showChar(u: UnencodableChar): string {
  if (u.codePoint === 0x00a0) return "（ノーブレークスペース）";
  if (u.codePoint < 0x20 || (u.codePoint >= 0x7f && u.codePoint < 0xa0)) return "（制御文字）";
  return u.char;
}

const codeLabel = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * CSVの書き出しの文字コードを選んでダウンロードする（CSVを書き出すツール共通）。
 *
 * - picker：ダウンロードの近くに置く、文字コードの選択（初期値はツールのこれまでの書き出しと同じ）。
 * - confirm：Shift_JISで表せない文字があったときの確認（書き出す前に出す。黙って書き出さない）。
 * - download(CSVの文字 または UTF-8のCSVのBlob, ファイル名)：選んだ文字コードに変換してダウンロードする。
 *   UTF-8（BOM付き）のままのときは、ツールが作ったBlobをそのまま使う（これまでと同じ出力）。
 */
export function useCsvExport(defaultEncoding: CsvExportEncoding = "utf-8-bom") {
  const [encoding, setEncoding] = useState<CsvExportEncoding>(defaultEncoding);
  const [pending, setPending] = useState<{ text: string; fileName: string; chars: UnencodableChar[] } | null>(null);

  async function download(source: Blob | string, fileName: string) {
    setPending(null);
    // これまでの初期設定のままなら、ツールが作ったものをそのまま書き出す（出力を変えない）
    if (encoding === defaultEncoding && source instanceof Blob) {
      downloadBlob(source, fileName);
      return;
    }
    const text = typeof source === "string" ? source : await csvBlobToText(source);
    if (encoding === "shift_jis") {
      const chars = findUnencodable(text);
      if (chars.length > 0) {
        setPending({ text, fileName, chars });
        return;
      }
    }
    downloadBlob(csvTextToBlob(text, encoding), fileName);
  }

  function finish(replaceNear: boolean) {
    if (!pending) return;
    downloadBlob(csvTextToBlob(pending.text, "shift_jis", { replaceNear }), pending.fileName);
    setPending(null);
  }

  const current = CSV_EXPORT_ENCODINGS.find((e) => e.value === encoding) ?? CSV_EXPORT_ENCODINGS[0];
  const picker: ReactNode = (
    <div className="flex flex-col gap-0.5 text-xs text-neutral-600 dark:text-neutral-300" data-testid="csv-export-encoding">
      <label className="flex flex-wrap items-center gap-2">
        <span>CSVの文字コード</span>
        <select
          value={encoding}
          onChange={(e) => {
            setEncoding(e.target.value as CsvExportEncoding);
            setPending(null);
          }}
          className="rounded-md border border-neutral-300 bg-white px-1.5 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
          data-testid="csv-export-encoding-select"
        >
          {CSV_EXPORT_ENCODINGS.map((e) => (
            <option key={e.value} value={e.value}>
              {e.label}
            </option>
          ))}
        </select>
      </label>
      <span className="text-neutral-500 dark:text-neutral-400">{current.hint}（ソフトによって対応が異なることがあります）</span>
    </div>
  );

  const hasNear = !!pending?.chars.some((c) => c.replacement);
  const confirm: ReactNode = pending ? (
    <div
      role="alertdialog"
      aria-label="Shift_JISで表せない文字の確認"
      className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
      data-testid="csv-export-unencodable"
    >
      <p className="font-semibold">Shift_JISで表現できない文字が含まれています。一部の文字が正しく表示されない可能性があります。</p>
      <ul className="max-h-40 overflow-auto rounded border border-amber-200 bg-white/60 dark:border-amber-900 dark:bg-neutral-900/40" data-testid="csv-export-unencodable-list">
        {pending.chars.map((c) => (
          <li key={c.codePoint} className="flex flex-wrap gap-x-2 px-2 py-1" data-testid="csv-export-unencodable-item" data-char={c.char}>
            <span className="font-semibold">「{showChar(c)}」</span>
            <span className="text-amber-800/80 dark:text-amber-300/80">{codeLabel(c.codePoint)}</span>
            <span>
              {c.count}か所（最初は {c.row}行目・{c.column}列目）
            </span>
            {c.replacement && <span>→ 近い文字「{c.replacement}」に置き換えられます</span>}
          </li>
        ))}
      </ul>
      <p>そのまま書き出すと、これらの文字は「?」になります。元のファイルや画面の内容は変わりません。</p>
      <div className="flex flex-wrap gap-2">
        {hasNear && (
          <button type="button" onClick={() => finish(true)} className="rounded-lg bg-amber-600 px-3 py-1.5 font-semibold text-white hover:bg-amber-700" data-testid="csv-export-replace-near">
            近い文字に置き換えて書き出す
          </button>
        )}
        <button type="button" onClick={() => finish(false)} className="rounded-lg border border-amber-400 bg-white px-3 py-1.5 font-semibold text-amber-900 hover:bg-amber-100 dark:bg-transparent dark:text-amber-200" data-testid="csv-export-as-is">
          そのまま書き出す（「?」になります）
        </button>
        <button type="button" onClick={() => setPending(null)} className="rounded-lg px-3 py-1.5 text-amber-900 underline dark:text-amber-200" data-testid="csv-export-cancel">
          キャンセル
        </button>
      </div>
    </div>
  ) : null;

  return { encoding, picker, confirm, download };
}
