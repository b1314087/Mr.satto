"use client";

import { useMemo, useState } from "react";
import {
  createEmptyEntry,
  formatReferenceList,
  segmentsToHtml,
  segmentsToPlain,
  type CitationStyle,
  type NumberingStyle,
  type ReferenceEntry,
  type ReferenceType,
  type SortOrder,
} from "@/lib/citation/format";
import { downloadBlob } from "@/lib/utils/format";

const STYLE_OPTIONS: { value: CitationStyle; label: string }[] = [
  { value: "ja", label: "日本語(一般的な書き方)" },
  { value: "apa", label: "APA 第7版" },
  { value: "ieee", label: "IEEE" },
];

const TYPE_LABEL: Record<ReferenceType, string> = { book: "書籍", article: "論文・記事", web: "Webページ" };

const inputClass =
  "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900";

let nextId = 1;
const newId = () => `ref-${nextId++}`;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">{label}</span>
      {children}
    </label>
  );
}

/**
 * 参考文献リスト整形。入力するとすぐ下の「整形結果」が更新される(プレビュー)。
 * 書式付きコピーでは書名・誌名の斜体もそのままWordなどへ貼り付けられる。処理はすべてブラウザ内。
 */
export function CitationFormatterTool() {
  const [entries, setEntries] = useState<ReferenceEntry[]>(() => [createEmptyEntry("book", newId())]);
  const [style, setStyle] = useState<CitationStyle>("ja");
  const [sort, setSort] = useState<SortOrder>("input");
  const [numbering, setNumbering] = useState<NumberingStyle>("bracket");
  const [allAuthors, setAllAuthors] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const formatted = useMemo(
    () => formatReferenceList(entries, { style, sort, numbering, allAuthors }),
    [entries, style, sort, numbering, allAuthors]
  );

  function update(id: string, patch: Partial<ReferenceEntry>) {
    setEntries((cur) => cur.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  function remove(id: string) {
    setEntries((cur) => (cur.length <= 1 ? [createEmptyEntry("book", newId())] : cur.filter((e) => e.id !== id)));
  }

  function showNotice(text: string) {
    setNotice(text);
    setTimeout(() => setNotice(null), 2000);
  }

  const plainText = formatted.map((f) => segmentsToPlain(f.segments)).join("\n");

  async function copyPlain() {
    try {
      await navigator.clipboard.writeText(plainText);
      showNotice("テキストをコピーしました");
    } catch {
      showNotice("コピーできませんでした。結果を選択して手動でコピーしてください");
    }
  }

  async function copyRich() {
    const html = `<div>${formatted.map((f) => `<p>${segmentsToHtml(f.segments)}</p>`).join("")}</div>`;
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plainText], { type: "text/plain" }),
        }),
      ]);
      showNotice("書式付きでコピーしました(斜体も保たれます)");
    } catch {
      await copyPlain();
    }
  }

  function download() {
    downloadBlob(new Blob([plainText + "\n"], { type: "text/plain;charset=utf-8" }), "references.txt");
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 rounded-xl border border-neutral-200 p-4 sm:grid-cols-2 lg:grid-cols-4 dark:border-neutral-800">
        <Field label="書き方">
          <select aria-label="書き方" value={style} onChange={(e) => setStyle(e.target.value as CitationStyle)} className={inputClass}>
            {STYLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="並び順">
          <select aria-label="並び順" value={sort} onChange={(e) => setSort(e.target.value as SortOrder)} className={inputClass}>
            <option value="input">入力した順</option>
            <option value="author">著者名順</option>
            <option value="year">発行年順</option>
          </select>
        </Field>
        <Field label="番号">
          <select aria-label="番号" value={numbering} onChange={(e) => setNumbering(e.target.value as NumberingStyle)} className={inputClass}>
            <option value="bracket">[1] [2] …</option>
            <option value="dot">1. 2. …</option>
            <option value="none">なし</option>
          </select>
        </Field>
        <label className="flex items-end gap-2 pb-2 text-sm text-neutral-700 dark:text-neutral-200">
          <input type="checkbox" checked={allAuthors} onChange={(e) => setAllAuthors(e.target.checked)} />
          著者を省略せず全員書く
        </label>
      </div>

      <ul className="flex flex-col gap-4">
        {entries.map((entry, index) => (
          <li key={entry.id} className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">文献 {index + 1}</span>
                <div className="flex gap-1" role="group" aria-label={`文献${index + 1}の種類`}>
                  {(Object.keys(TYPE_LABEL) as ReferenceType[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={entry.type === t}
                      onClick={() => update(entry.id, { type: t })}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                        entry.type === t
                          ? "bg-blue-600 text-white"
                          : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                      }`}
                    >
                      {TYPE_LABEL[t]}
                    </button>
                  ))}
                </div>
              </div>
              <button
                type="button"
                onClick={() => remove(entry.id)}
                aria-label={`文献${index + 1}を削除`}
                className="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                削除
              </button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={entry.type === "web" ? "著者・運営者(任意)" : "著者(複数は「、」で区切る)"}>
                <input
                  type="text"
                  aria-label={`文献${index + 1}の著者`}
                  value={entry.authors}
                  onChange={(e) => update(entry.id, { authors: e.target.value })}
                  placeholder="山田太郎、佐藤花子 / John Smith, Mary Doe"
                  className={inputClass}
                />
              </Field>
              <Field label="発行年">
                <input
                  type="text"
                  inputMode="numeric"
                  aria-label={`文献${index + 1}の発行年`}
                  value={entry.year}
                  onChange={(e) => update(entry.id, { year: e.target.value })}
                  placeholder="2024"
                  className={inputClass}
                />
              </Field>
              <div className="sm:col-span-2">
                <Field label="題名">
                  <input
                    type="text"
                    aria-label={`文献${index + 1}の題名`}
                    value={entry.title}
                    onChange={(e) => update(entry.id, { title: e.target.value })}
                    className={inputClass}
                  />
                </Field>
              </div>

              {entry.type === "book" && (
                <>
                  <Field label="出版社">
                    <input type="text" aria-label={`文献${index + 1}の出版社`} value={entry.publisher} onChange={(e) => update(entry.id, { publisher: e.target.value })} className={inputClass} />
                  </Field>
                  <Field label="版(任意)">
                    <input type="text" aria-label={`文献${index + 1}の版`} value={entry.edition} onChange={(e) => update(entry.id, { edition: e.target.value })} placeholder="第2版" className={inputClass} />
                  </Field>
                </>
              )}

              {entry.type === "article" && (
                <>
                  <div className="sm:col-span-2">
                    <Field label="雑誌名・掲載誌">
                      <input type="text" aria-label={`文献${index + 1}の雑誌名`} value={entry.journal} onChange={(e) => update(entry.id, { journal: e.target.value })} className={inputClass} />
                    </Field>
                  </div>
                  <div className="grid grid-cols-3 gap-3 sm:col-span-2">
                    <Field label="巻">
                      <input type="text" aria-label={`文献${index + 1}の巻`} value={entry.volume} onChange={(e) => update(entry.id, { volume: e.target.value })} className={inputClass} />
                    </Field>
                    <Field label="号">
                      <input type="text" aria-label={`文献${index + 1}の号`} value={entry.issue} onChange={(e) => update(entry.id, { issue: e.target.value })} className={inputClass} />
                    </Field>
                    <Field label="ページ">
                      <input type="text" aria-label={`文献${index + 1}のページ`} value={entry.pages} onChange={(e) => update(entry.id, { pages: e.target.value })} placeholder="45-67" className={inputClass} />
                    </Field>
                  </div>
                </>
              )}

              {entry.type === "web" && (
                <>
                  <Field label="サイト名">
                    <input type="text" aria-label={`文献${index + 1}のサイト名`} value={entry.siteName} onChange={(e) => update(entry.id, { siteName: e.target.value })} className={inputClass} />
                  </Field>
                  <Field label="閲覧日">
                    <input type="date" aria-label={`文献${index + 1}の閲覧日`} value={entry.accessed} onChange={(e) => update(entry.id, { accessed: e.target.value })} className={inputClass} />
                  </Field>
                  <div className="sm:col-span-2">
                    <Field label="URL">
                      <input type="url" aria-label={`文献${index + 1}のURL`} value={entry.url} onChange={(e) => update(entry.id, { url: e.target.value })} placeholder="https://" className={inputClass} />
                    </Field>
                  </div>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={() => setEntries((cur) => [...cur, createEmptyEntry("book", newId())])}
        className="self-start rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
      >
        文献を追加
      </button>

      <section aria-labelledby="citation-result" className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="citation-result" className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
            整形結果(プレビュー)
          </h2>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={copyRich} disabled={formatted.length === 0} className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-40">
              書式付きでコピー
            </button>
            <button type="button" onClick={copyPlain} disabled={formatted.length === 0} className="rounded-md bg-white px-3 py-1.5 text-xs text-neutral-700 ring-1 ring-neutral-300 hover:bg-neutral-100 disabled:opacity-40 dark:bg-neutral-800 dark:text-neutral-200 dark:ring-neutral-700">
              テキストをコピー
            </button>
            <button type="button" onClick={download} disabled={formatted.length === 0} className="rounded-md bg-white px-3 py-1.5 text-xs text-neutral-700 ring-1 ring-neutral-300 hover:bg-neutral-100 disabled:opacity-40 dark:bg-neutral-800 dark:text-neutral-200 dark:ring-neutral-700">
              .txtで保存
            </button>
          </div>
        </div>
        {notice && (
          <p role="status" className="text-xs text-green-700 dark:text-green-400">
            {notice}
          </p>
        )}
        {formatted.length === 0 ? (
          <p className="text-sm text-neutral-400">文献の情報を入力すると、ここに整形結果が表示されます。</p>
        ) : (
          <ol data-testid="citation-result-list" className="flex flex-col gap-2">
            {formatted.map((f) => (
              <li key={f.id} className="rounded-lg bg-white p-3 text-sm leading-relaxed text-neutral-800 dark:bg-neutral-950 dark:text-neutral-200">
                {f.segments.map((s, i) => (s.italic ? <i key={i}>{s.text}</i> : <span key={i}>{s.text}</span>))}
                {f.warnings.length > 0 && (
                  <span className="mt-1 block text-xs text-amber-700 dark:text-amber-400">未入力: {f.warnings.join(" / ")}</span>
                )}
              </li>
            ))}
          </ol>
        )}
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          代表的な書き方に沿って整形しています。学会・大学・出版社ごとに細かな規定が異なるため、提出先の指定を必ず確認してください。
        </p>
      </section>
    </div>
  );
}
