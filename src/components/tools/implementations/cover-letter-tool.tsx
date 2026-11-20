"use client";

import { useEffect, useState } from "react";
import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { StepHeading } from "@/components/ui/step-heading";
import { SettingsSection, SettingsStack } from "@/components/ui/settings-section";
import { RunBar } from "@/components/ui/run-bar";
import { LabeledField } from "./shared/party-info-form";
import {
  COMMON_DOCUMENT_NAMES,
  COVER_LETTER_BLOCKS,
  COVER_LETTER_KIND_META,
  LAYOUT_X_RANGE,
  LAYOUT_Y_RANGE,
  MAX_RECIPIENTS,
  SENDER_STORAGE_KEY,
  activeRecipients,
  clampLayout,
  coverLetterBaseName,
  coverLetterTitle,
  createDefaultLayout,
  createEmptyCoverLetter,
  createEmptyRecipient,
  defaultGreeting,
  formatJapaneseDate,
  isLayoutChanged,
  isRecipientEmpty,
  itemLines,
  newItemId,
  parsePartyText,
  parseRecipientRows,
  parseRecipientText,
  parseStoredSender,
  recipientLines,
  senderLines,
  validateCoverLetter,
  type CoverLetterBlock,
  type CoverLetterForm,
  type CoverLetterKind,
  type CoverLetterRecipient,
  type CoverLetterSender,
} from "@/lib/documents/cover-letter";
import { SliderField } from "@/components/common/slider-field";
import { CoverLetterPdfProcessor } from "@/lib/processors/browser/cover-letter-pdf";
import { buildCoverLetterDocx } from "@/lib/documents/cover-letter-docx";
import { downloadBlob, formatBytes, sanitizeFileName } from "@/lib/utils/format";
import { runWithDownloadAccess } from "@/lib/download/download-gate";

/**
 * 送付状作成（2026-11-20）。書類送付状・FAX送付状を、入力するだけでA4のPDFにする。
 * - PDFはブラウザの中だけで作る（入力した内容をサーバーに送らない）。
 * - 差出人は、利用者が選んだときだけ、この端末のブラウザに保存する（次回から自動で入る）。
 * - 2026-11-20：Word（.docx）でも出力できる。宛先を複数にすると1宛先＝1ページでまとめて作る。
 *   宛先・差出人は、Excelの表やメールの署名を貼り付けて入れられる。各項目の位置をバーで動かせる。
 */

type OutputFormat = "pdf" | "word";

interface GeneratedFile {
  blob: Blob;
  url: string;
  name: string;
  format: OutputFormat;
  pages: number;
  sizeBytes: number;
}

const inputClass =
  "rounded-lg border border-neutral-300 px-3 py-2 text-sm font-normal text-neutral-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100";

function readSender(): CoverLetterSender | null {
  try {
    return parseStoredSender(window.localStorage.getItem(SENDER_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function CoverLetterTool() {
  const [form, setForm] = useState<CoverLetterForm>(() => createEmptyCoverLetter("document"));
  const [rememberSender, setRememberSender] = useState(false);
  const [format, setFormat] = useState<OutputFormat>("pdf");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GeneratedFile | null>(null);
  // プレビューに出す宛先（何件目か）
  const [previewIndex, setPreviewIndex] = useState(0);
  const [recipientPaste, setRecipientPaste] = useState("");
  const [senderPaste, setSenderPaste] = useState("");
  const [pasteNote, setPasteNote] = useState<string | null>(null);

  // 保存した差出人があれば、最初に入れる（ブラウザの中だけ）
  useEffect(() => {
    const saved = readSender();
    if (saved) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setForm((f) => ({ ...f, sender: saved }));
      setRememberSender(true);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  function patch(p: Partial<CoverLetterForm>) {
    setForm((f) => ({ ...f, ...p }));
    setResult(null);
  }
  function setRecipient(index: number, key: keyof CoverLetterRecipient, value: string) {
    patch({ recipients: form.recipients.map((r, i) => (i === index ? { ...r, [key]: value } : r)) });
  }
  function setSender(key: keyof CoverLetterSender, value: string) {
    patch({ sender: { ...form.sender, [key]: value } });
  }
  function setOffset(block: CoverLetterBlock, axis: "x" | "y", value: number) {
    patch({ layout: clampLayout({ ...form.layout, [block]: { ...form.layout[block], [axis]: value } }) });
  }
  function changeKind(kind: CoverLetterKind) {
    // あいさつ文をひな形のまま使っていたときだけ、種類に合わせて入れ替える（書き換えた文は残す）
    const greeting = form.greeting === defaultGreeting(form.kind) ? defaultGreeting(kind) : form.greeting;
    patch({ kind, greeting });
  }

  /** 貼り付けた宛先を追加する。表（タブ・カンマ区切り）なら1行1件、そうでなければ署名などとして1件 */
  function addPastedRecipients() {
    const text = recipientPaste.trim();
    if (!text) return;
    // タブがあればExcelの表、2行以上がすべてカンマ区切りならCSV。それ以外は、署名などのかたまり（1件）として読む
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    const isTable = /\t/.test(text) || (lines.length > 1 && lines.every((l) => /[,，]/.test(l)));
    let added: CoverLetterRecipient[] = isTable ? parseRecipientRows(text) : [];
    if (added.length === 0) {
      const one = parseRecipientText(text);
      added = isRecipientEmpty(one) ? [] : [one];
    }
    if (added.length === 0) {
      setPasteNote("宛先として読み取れる内容がありませんでした。");
      return;
    }
    // 空の宛先だけのときは、置き換える
    const kept = form.recipients.filter((r) => !isRecipientEmpty(r) || r.fax.trim() || r.tel.trim());
    const next = [...kept, ...added].slice(0, MAX_RECIPIENTS);
    patch({ recipients: next.length > 0 ? next : [createEmptyRecipient()] });
    setPreviewIndex(kept.length);
    setRecipientPaste("");
    setPasteNote(`${added.length}件の宛先を追加しました（全部で${next.length}件）。内容を確かめて、違うところは直してください。`);
  }

  /** 貼り付けた署名などから、差出人の欄を埋める（読み取れた欄だけ書き換える） */
  function applyPastedSender() {
    const parsed = parsePartyText(senderPaste);
    const filled = (Object.keys(parsed) as (keyof CoverLetterSender)[]).filter((k) => parsed[k].trim() !== "");
    if (filled.length === 0) {
      setPasteNote("差出人として読み取れる内容がありませんでした。");
      return;
    }
    const next = { ...form.sender };
    for (const k of filled) next[k] = parsed[k];
    patch({ sender: next });
    setSenderPaste("");
    setPasteNote("差出人の欄に入れました。内容を確かめて、違うところは直してください。");
  }

  async function handleGenerate() {
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      try {
        if (rememberSender) window.localStorage.setItem(SENDER_STORAGE_KEY, JSON.stringify(form.sender));
        else window.localStorage.removeItem(SENDER_STORAGE_KEY);
      } catch {
        // 保存できなくても、ファイルは作る
      }
      const base = coverLetterBaseName(form);
      if (format === "word") {
        const blob = await buildCoverLetterDocx(form);
        setResult({ blob, url: URL.createObjectURL(blob), name: sanitizeFileName(`${base}.docx`), format, pages: activeRecipients(form).length, sizeBytes: blob.size });
      } else {
        const output = await new CoverLetterPdfProcessor().process({ form });
        setResult({ blob: output.blob, url: output.url, name: sanitizeFileName(`${base}.pdf`), format, pages: output.pageCount, sizeBytes: output.sizeBytes });
      }
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "ファイルの作成に失敗しました");
      setStatus("error");
    }
  }

  const problem = validateCoverLetter(form);
  const meta = COVER_LETTER_KIND_META[form.kind];
  const active = activeRecipients(form);
  const recipientCount = active.length;
  const shownIndex = Math.min(previewIndex, Math.max(0, recipientCount - 1));
  const shownRecipient = active[shownIndex] ?? form.recipients[0] ?? createEmptyRecipient();
  const filledItems = itemLines(form.items);

  return (
    <PreviewSplitLayout
      previewWidth="lg"
      after={
        <section className="flex flex-col gap-3">
          <StepHeading n={9} as="h2">
            出力
          </StepHeading>
          <div role="radiogroup" aria-label="出力する形式" className="flex flex-wrap gap-2">
            {(["pdf", "word"] as OutputFormat[]).map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={format === f}
                data-testid={`cover-letter-format-${f}`}
                onClick={() => {
                  setFormat(f);
                  setResult(null);
                }}
                className={`rounded-lg border px-4 py-2 text-sm font-semibold ${
                  format === f ? "border-blue-600 bg-blue-50 text-blue-800 dark:bg-blue-950 dark:text-blue-200" : "border-neutral-300 dark:border-neutral-700"
                }`}
              >
                {f === "pdf" ? "PDF" : "Word（.docx・あとで書き直せる）"}
              </button>
            ))}
          </div>
          <RunBar note={problem ?? "入力内容は画面を閉じると消えます（差出人は、保存を選んだときだけこの端末に残ります）"}>
            <button
              type="button"
              data-testid="cover-letter-generate"
              onClick={() => void handleGenerate()}
              disabled={status === "processing"}
              aria-busy={status === "processing" || undefined}
              title={problem ?? undefined}
              className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {status === "processing" ? "作成中..." : `${meta.label}を作成する${recipientCount > 1 ? `（${recipientCount}件）` : ""}`}
            </button>
          </RunBar>
          <ProcessingStatus state={status} processingLabel="ファイルを作成中..." successLabel={format === "word" ? "Wordを作成しました" : "PDFを作成しました"} />
          {error && <ErrorMessage message={error} />}
          {result && (
            <ResultPopup>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {result.format === "word" ? `${result.pages}件` : `${result.pages}ページ`} ・ {formatBytes(result.sizeBytes)}
              </p>
              <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, result.name)} label={result.format === "word" ? "Wordをダウンロード" : "PDFをダウンロード"} />
              {result.format === "pdf" && (
                <button
                  type="button"
                  onClick={() =>
                    runWithDownloadAccess({
                      key: result.url,
                      label: "PDFを新しいタブで開く",
                      run: () => window.open(result.url, "_blank", "noopener,noreferrer"),
                    })
                  }
                  className="text-xs text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
                >
                  新しいタブでPDFを開く（印刷はこちらから）
                </button>
              )}
            </ResultPopup>
          )}
        </section>
      }
      preview={
        <section className="flex flex-col gap-3">
          <StepHeading n={8} as="h2">
            プレビュー
          </StepHeading>
          {recipientCount > 1 && (
            <div className="flex items-center gap-2 text-sm" data-testid="cover-letter-preview-nav">
              <button type="button" aria-label="前の宛先" disabled={shownIndex <= 0} onClick={() => setPreviewIndex(shownIndex - 1)} className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-40 dark:border-neutral-700">
                ◀
              </button>
              <span data-testid="cover-letter-preview-count">
                {shownIndex + 1} / {recipientCount}件目
              </span>
              <button type="button" aria-label="次の宛先" disabled={shownIndex >= recipientCount - 1} onClick={() => setPreviewIndex(shownIndex + 1)} className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-40 dark:border-neutral-700">
                ▶
              </button>
            </div>
          )}
          <div data-testid="tool-preview">
            <CoverLetterPreview form={form} recipient={shownRecipient} />
          </div>
        </section>
      }
    >
      <SettingsStack testId="cover-letter-settings">
        <SettingsSection n={1} title="種類・日付・件名" summary={`${meta.label}・${formatJapaneseDate(form.date)}`}>
          <div className="flex flex-col gap-3">
            <div role="radiogroup" aria-label="送付状の種類" className="flex flex-wrap gap-2">
              {(Object.keys(COVER_LETTER_KIND_META) as CoverLetterKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={form.kind === k}
                  data-testid={`cover-letter-kind-${k}`}
                  onClick={() => changeKind(k)}
                  className={`rounded-lg border px-4 py-2 text-sm font-semibold ${
                    form.kind === k ? "border-blue-600 bg-blue-50 text-blue-800 dark:bg-blue-950 dark:text-blue-200" : "border-neutral-300 dark:border-neutral-700"
                  }`}
                >
                  {COVER_LETTER_KIND_META[k].label}
                </button>
              ))}
            </div>
            <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-300">
              日付
              <input type="date" value={form.date} onChange={(e) => patch({ date: e.target.value })} className={inputClass} />
            </label>
            <LabeledField label="件名（空なら「書類送付のご案内」など）" value={form.subject} onChange={(v) => patch({ subject: v })} placeholder={meta.title} />
          </div>
        </SettingsSection>

        <SettingsSection n={2} title="宛先" summary={recipientCount > 1 ? `${recipientCount}件` : recipientLines(shownRecipient).join(" ") || "未入力"}>
          <div className="flex flex-col gap-3">
            {form.recipients.map((r, i) => (
              <div key={r.id ?? i} data-testid="cover-letter-recipient" className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
                {form.recipients.length > 1 && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-neutral-600 dark:text-neutral-300">{i + 1}件目</span>
                    <button
                      type="button"
                      aria-label={`${i + 1}件目の宛先を削除`}
                      onClick={() => {
                        patch({ recipients: form.recipients.filter((_, j) => j !== i) });
                        setPreviewIndex(0);
                      }}
                      className="rounded border border-neutral-300 px-2 py-0.5 text-xs dark:border-neutral-700"
                    >
                      削除
                    </button>
                  </div>
                )}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <LabeledField label={i === 0 ? "会社名" : `会社名（${i + 1}件目）`} value={r.companyName} onChange={(v) => setRecipient(i, "companyName", v)} placeholder="例: 株式会社サンプル" />
                  <LabeledField label={i === 0 ? "部署名" : `部署名（${i + 1}件目）`} value={r.department} onChange={(v) => setRecipient(i, "department", v)} placeholder="例: 総務部" />
                  <LabeledField
                    label={i === 0 ? "担当者名（入れると「様」、空なら「御中」）" : `担当者名（${i + 1}件目）`}
                    value={r.contactName}
                    onChange={(v) => setRecipient(i, "contactName", v)}
                    placeholder="例: 山田 太郎"
                  />
                  {form.kind === "fax" && (
                    <>
                      <LabeledField label={i === 0 ? "宛先のFAX番号" : `宛先のFAX番号（${i + 1}件目）`} value={r.fax} onChange={(v) => setRecipient(i, "fax", v)} placeholder="例: 03-1234-5679" type="tel" />
                      <LabeledField label={i === 0 ? "宛先の電話番号" : `宛先の電話番号（${i + 1}件目）`} value={r.tel} onChange={(v) => setRecipient(i, "tel", v)} placeholder="例: 03-1234-5678" type="tel" />
                    </>
                  )}
                </div>
              </div>
            ))}
            <button
              type="button"
              data-testid="cover-letter-add-recipient"
              disabled={form.recipients.length >= MAX_RECIPIENTS}
              onClick={() => {
                patch({ recipients: [...form.recipients, createEmptyRecipient()] });
              }}
              className="w-fit rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-semibold disabled:opacity-40 dark:border-neutral-700"
            >
              ＋ 宛先を追加（1宛先＝1ページ）
            </button>
            <div className="flex flex-col gap-1.5 rounded-lg bg-neutral-50 p-3 dark:bg-neutral-900">
              <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-300">
                貼り付けて宛先を追加（Excelの表をコピーすると1行1件。列は「会社名・部署名・担当者名・FAX・電話」の順か、1行目の見出しで決めます。メールの署名などを貼ると1件として読みます）
                <textarea
                  data-testid="cover-letter-recipient-paste"
                  value={recipientPaste}
                  onChange={(e) => setRecipientPaste(e.target.value)}
                  rows={3}
                  placeholder={"例（Excelからコピー）:\n株式会社サンプル\t総務部\t山田 太郎\n合同会社テスト\t\t佐藤 花子"}
                  className={inputClass}
                />
              </label>
              <button
                type="button"
                data-testid="cover-letter-recipient-paste-apply"
                disabled={recipientPaste.trim() === ""}
                onClick={addPastedRecipients}
                className="w-fit rounded-lg bg-neutral-800 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40 dark:bg-neutral-200 dark:text-neutral-900"
              >
                宛先に追加する
              </button>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection n={3} title="差出人（自分・自社）" summary={senderLines(form.sender)[0] ?? "未入力"}>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <LabeledField label="会社名・屋号" value={form.sender.companyName} onChange={(v) => setSender("companyName", v)} placeholder="例: 株式会社サンプル" autoComplete="organization" />
              <LabeledField label="部署名" value={form.sender.department} onChange={(v) => setSender("department", v)} placeholder="例: 営業部" />
              <LabeledField label="担当者名" value={form.sender.contactName} onChange={(v) => setSender("contactName", v)} placeholder="例: 佐藤 花子" autoComplete="name" />
              <LabeledField label="郵便番号" value={form.sender.postalCode} onChange={(v) => setSender("postalCode", v)} placeholder="例: 650-0001" autoComplete="postal-code" inputMode="numeric" />
            </div>
            <LabeledField label="住所" value={form.sender.address} onChange={(v) => setSender("address", v)} placeholder="例: 兵庫県神戸市中央区1-1-1" autoComplete="street-address" />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <LabeledField label="電話番号" value={form.sender.tel} onChange={(v) => setSender("tel", v)} placeholder="例: 078-123-4567" type="tel" autoComplete="tel" />
              <LabeledField label="FAX番号" value={form.sender.fax} onChange={(v) => setSender("fax", v)} placeholder="例: 078-123-4568" type="tel" />
            </div>
            <LabeledField label="メールアドレス" value={form.sender.email} onChange={(v) => setSender("email", v)} placeholder="例: info@example.com" type="email" autoComplete="email" />
            <div className="flex flex-col gap-1.5 rounded-lg bg-neutral-50 p-3 dark:bg-neutral-900">
              <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-300">
                メールの署名・名刺の文字などを貼り付けて入れる（会社名・部署・氏名・〒・住所・TEL・FAX・メールを自動で分けます）
                <textarea
                  data-testid="cover-letter-sender-paste"
                  value={senderPaste}
                  onChange={(e) => setSenderPaste(e.target.value)}
                  rows={3}
                  placeholder={"例:\n株式会社サンプル 営業部\n佐藤 花子\n〒650-0001 兵庫県神戸市中央区1-1-1\nTEL 078-123-4567 / FAX 078-123-4568"}
                  className={inputClass}
                />
              </label>
              <button
                type="button"
                data-testid="cover-letter-sender-paste-apply"
                disabled={senderPaste.trim() === ""}
                onClick={applyPastedSender}
                className="w-fit rounded-lg bg-neutral-800 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40 dark:bg-neutral-200 dark:text-neutral-900"
              >
                差出人に入れる
              </button>
            </div>
            <label className="flex items-start gap-2 text-xs text-neutral-700 dark:text-neutral-300">
              <input type="checkbox" data-testid="cover-letter-remember-sender" checked={rememberSender} onChange={(e) => setRememberSender(e.target.checked)} className="mt-0.5" />
              <span>差出人をこの端末に保存し、次回から自動で入れる（保存はこのブラウザの中だけで、サーバーには送りません。共用のパソコンでは使わないでください）</span>
            </label>
          </div>
        </SettingsSection>

        <SettingsSection n={4} title="あいさつ文" summary="拝啓〜敬具（自由に書き換えられます）" defaultOpen={false}>
          <div className="flex flex-col gap-2">
            <textarea
              aria-label="あいさつ文"
              value={form.greeting}
              onChange={(e) => patch({ greeting: e.target.value })}
              rows={7}
              className={`${inputClass} leading-relaxed`}
            />
            <button type="button" onClick={() => patch({ greeting: defaultGreeting(form.kind) })} className="w-fit text-xs text-blue-600 underline-offset-2 hover:underline dark:text-blue-400">
              ひな形に戻す
            </button>
          </div>
        </SettingsSection>

        <SettingsSection n={5} title="送付書類" summary={filledItems.length > 0 ? `${filledItems.length}件` : form.kind === "fax" ? "任意" : "未入力"}>
          <div className="flex flex-col gap-2">
            <datalist id="cover-letter-doc-names">
              {COMMON_DOCUMENT_NAMES.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
            {form.items.map((it, i) => (
              <div key={it.id} className="flex items-end gap-2">
                <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-300">
                  {`書類${i + 1}`}
                  <input
                    list="cover-letter-doc-names"
                    value={it.name}
                    onChange={(e) => patch({ items: form.items.map((x) => (x.id === it.id ? { ...x, name: e.target.value } : x)) })}
                    placeholder="例: 見積書"
                    className={inputClass}
                  />
                </label>
                <label className="flex w-20 flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-300">
                  部数
                  <input
                    value={it.copies}
                    inputMode="numeric"
                    onChange={(e) => patch({ items: form.items.map((x) => (x.id === it.id ? { ...x, copies: e.target.value } : x)) })}
                    className={inputClass}
                  />
                </label>
                <button
                  type="button"
                  aria-label={`書類${i + 1}を削除`}
                  disabled={form.items.length <= 1}
                  onClick={() => patch({ items: form.items.filter((x) => x.id !== it.id) })}
                  className="mb-1 rounded border border-neutral-300 px-2 py-1 text-xs disabled:opacity-40 dark:border-neutral-700"
                >
                  削除
                </button>
              </div>
            ))}
            <button
              type="button"
              data-testid="cover-letter-add-item"
              disabled={form.items.length >= 20}
              onClick={() => patch({ items: [...form.items, { id: newItemId(), name: "", copies: "1" }] })}
              className="w-fit rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-semibold disabled:opacity-40 dark:border-neutral-700"
            >
              ＋ 書類を追加
            </button>
            {form.kind === "fax" && (
              <LabeledField label="送信枚数（この送付状を含む）" value={form.faxPages} onChange={(v) => patch({ faxPages: v })} placeholder="例: 3" inputMode="numeric" />
            )}
          </div>
        </SettingsSection>

        <SettingsSection n={6} title="連絡事項（任意）" summary={form.notes.trim() ? "入力済み" : "任意"} defaultOpen={false}>
          <textarea
            aria-label="連絡事項"
            value={form.notes}
            onChange={(e) => patch({ notes: e.target.value })}
            rows={4}
            placeholder="例: ご確認のうえ、ご署名・ご捺印をいただき、ご返送をお願いいたします。"
            className={inputClass}
          />
        </SettingsSection>
        <SettingsSection n={7} title="位置の調整" summary={isLayoutChanged(form.layout) ? "変更あり" : "標準の位置"} defaultOpen={false} testId="cover-letter-layout">
          <div className="flex flex-col gap-4">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              項目ごとに、横（右へ＋）と縦（下へ＋）の位置をmm単位で動かせます。プレビュー・PDF・Wordのどれにも同じように効きます（Wordは段落の字下げ・前の空きで動かします）。
            </p>
            {COVER_LETTER_BLOCKS.map((b) => (
              <div key={b.id} className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
                <p className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">{b.label}</p>
                <SliderField
                  label="横の位置（X）"
                  ariaLabel={`${b.label} 横の位置`}
                  value={form.layout[b.id].x}
                  min={LAYOUT_X_RANGE.min}
                  max={LAYOUT_X_RANGE.max}
                  unit="mm"
                  onChange={(v) => setOffset(b.id, "x", v)}
                  onReset={form.layout[b.id].x !== 0 ? () => setOffset(b.id, "x", 0) : undefined}
                />
                <SliderField
                  label="縦の位置（Y）"
                  ariaLabel={`${b.label} 縦の位置`}
                  value={form.layout[b.id].y}
                  min={LAYOUT_Y_RANGE.min}
                  max={LAYOUT_Y_RANGE.max}
                  unit="mm"
                  onChange={(v) => setOffset(b.id, "y", v)}
                  onReset={form.layout[b.id].y !== 0 ? () => setOffset(b.id, "y", 0) : undefined}
                />
              </div>
            ))}
            <button
              type="button"
              data-testid="cover-letter-layout-reset"
              disabled={!isLayoutChanged(form.layout)}
              onClick={() => patch({ layout: createDefaultLayout() })}
              className="w-fit rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-semibold disabled:opacity-40 dark:border-neutral-700"
            >
              すべて標準の位置に戻す
            </button>
          </div>
        </SettingsSection>
      </SettingsStack>
      {pasteNote && (
        <p data-testid="cover-letter-paste-note" role="status" className="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:bg-blue-950 dark:text-blue-100">
          {pasteNote}
        </p>
      )}
    </PreviewSplitLayout>
  );
}

/** 画面のプレビュー（PDFと同じ並び・同じ文面・同じずらし量） */
export function CoverLetterPreview({ form, recipient }: { form: CoverLetterForm; recipient: CoverLetterRecipient }) {
  const to = recipientLines(recipient);
  const from = senderLines(form.sender);
  const items = itemLines(form.items);
  const greetingLines = form.greeting.replace(/\s+$/, "").split(/\r\n|\r|\n/);
  const layout = clampLayout(form.layout);
  // ずらし量（mm）を、用紙の幅（210mm）に対する割合にする。left・margin-top の % は、どちらも外側の幅が基準
  const shift = (b: CoverLetterBlock): React.CSSProperties => ({
    position: "relative",
    left: `${(layout[b].x / 210) * 100}%`,
    marginTop: `${(layout[b].y / 210) * 100}%`,
  });
  return (
    <div data-testid="cover-letter-preview" className="aspect-[1/1.414] w-full overflow-hidden rounded-xl border border-neutral-200 bg-white p-6 text-[11px] leading-relaxed text-neutral-900 shadow-sm dark:border-neutral-800 sm:p-8 sm:text-xs">
      <p className="text-right" style={shift("date")} data-testid="cover-letter-preview-date">
        {formatJapaneseDate(form.date)}
      </p>
      <div className="mt-3" style={shift("recipient")}>
        {to.length === 0 ? (
          <p className="text-neutral-400">（宛先）</p>
        ) : (
          to.map((line, i) => (
            <p key={i} className={i === to.length - 1 ? "inline-block border-b border-neutral-500 pr-6 text-sm font-semibold" : ""}>
              {line}
            </p>
          ))
        )}
        {form.kind === "fax" && (recipient.fax || recipient.tel) && (
          <p className="mt-1 text-neutral-600">{[recipient.fax && `FAX：${recipient.fax}`, recipient.tel && `TEL：${recipient.tel}`].filter(Boolean).join("　")}</p>
        )}
      </div>
      <div className="ml-auto mt-3 w-1/2" style={shift("sender")}>
        {from.length === 0 ? <p className="text-neutral-400">（差出人）</p> : from.map((line, i) => <p key={i} className={i === 0 ? "font-semibold" : ""}>{line}</p>)}
      </div>
      <p className="mt-5 text-center text-base font-bold" style={shift("title")}>
        {coverLetterTitle(form)}
      </p>
      <div className="mt-3" style={shift("body")}>
        {greetingLines.map((line, i) =>
          /^\s*(敬具|敬白|草々|以上)\s*$/.test(line) ? (
            <p key={i} className="text-right">
              {line.trim()}
            </p>
          ) : (
            <p key={i} className="whitespace-pre-wrap">
              {line || "\u00a0"}
            </p>
          ),
        )}
      </div>
      {(items.length > 0 || (form.kind === "fax" && form.faxPages.trim())) && (
        <div className="mt-4" style={shift("items")}>
          <p className="text-center">記</p>
          <ol className="mt-2 pl-8">
            {items.map((line, i) => (
              <li key={i}>
                {i + 1}．{line}
              </li>
            ))}
          </ol>
          {form.kind === "fax" && form.faxPages.trim() && <p className="mt-1 pl-8">送信枚数：{form.faxPages.trim()}枚（本紙を含む）</p>}
        </div>
      )}
      {form.notes.trim() && (
        <div className="mt-4" style={shift("notes")}>
          <p>【連絡事項】</p>
          <p className="whitespace-pre-wrap pl-2">{form.notes.trim()}</p>
        </div>
      )}
      <p className="mt-4 text-right">以上</p>
    </div>
  );
}
