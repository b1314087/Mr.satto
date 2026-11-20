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
  COVER_LETTER_KIND_META,
  SENDER_STORAGE_KEY,
  coverLetterTitle,
  createEmptyCoverLetter,
  defaultGreeting,
  formatJapaneseDate,
  itemLines,
  newItemId,
  parseStoredSender,
  recipientLines,
  senderLines,
  validateCoverLetter,
  type CoverLetterForm,
  type CoverLetterKind,
  type CoverLetterRecipient,
  type CoverLetterSender,
} from "@/lib/documents/cover-letter";
import { CoverLetterPdfProcessor, buildCoverLetterFileName, type CoverLetterPdfOutput } from "@/lib/processors/browser/cover-letter-pdf";
import { downloadBlob, formatBytes } from "@/lib/utils/format";
import { runWithDownloadAccess } from "@/lib/download/download-gate";

/**
 * 送付状作成（2026-11-20）。書類送付状・FAX送付状を、入力するだけでA4のPDFにする。
 * - PDFはブラウザの中だけで作る（入力した内容をサーバーに送らない）。
 * - 差出人は、利用者が選んだときだけ、この端末のブラウザに保存する（次回から自動で入る）。
 */

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
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CoverLetterPdfOutput | null>(null);

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
  function setRecipient(key: keyof CoverLetterRecipient, value: string) {
    patch({ recipient: { ...form.recipient, [key]: value } });
  }
  function setSender(key: keyof CoverLetterSender, value: string) {
    patch({ sender: { ...form.sender, [key]: value } });
  }
  function changeKind(kind: CoverLetterKind) {
    // あいさつ文をひな形のまま使っていたときだけ、種類に合わせて入れ替える（書き換えた文は残す）
    const greeting = form.greeting === defaultGreeting(form.kind) ? defaultGreeting(kind) : form.greeting;
    patch({ kind, greeting });
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
        // 保存できなくても、PDFは作る
      }
      const output = await new CoverLetterPdfProcessor().process({ form });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "PDFの作成に失敗しました");
      setStatus("error");
    }
  }

  const problem = validateCoverLetter(form);
  const meta = COVER_LETTER_KIND_META[form.kind];
  const filledItems = itemLines(form.items);

  return (
    <PreviewSplitLayout
      previewWidth="lg"
      after={
        <section className="flex flex-col gap-3">
          <StepHeading n={8} as="h2">
            PDF出力
          </StepHeading>
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
              {status === "processing" ? "作成中..." : `${meta.label}を作成する`}
            </button>
          </RunBar>
          <ProcessingStatus state={status} processingLabel="PDFを作成中..." successLabel="PDFを作成しました" />
          {error && <ErrorMessage message={error} />}
          {result && (
            <ResultPopup>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {result.pageCount}ページ ・ {formatBytes(result.sizeBytes)}
              </p>
              <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, buildCoverLetterFileName(form))} label="PDFをダウンロード" />
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
            </ResultPopup>
          )}
        </section>
      }
      preview={
        <section className="flex flex-col gap-3">
          <StepHeading n={7} as="h2">
            プレビュー
          </StepHeading>
          <div data-testid="tool-preview">
            <CoverLetterPreview form={form} />
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

        <SettingsSection n={2} title="宛先" summary={recipientLines(form.recipient).join(" ") || "未入力"}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <LabeledField label="会社名" value={form.recipient.companyName} onChange={(v) => setRecipient("companyName", v)} placeholder="例: 株式会社サンプル" />
            <LabeledField label="部署名" value={form.recipient.department} onChange={(v) => setRecipient("department", v)} placeholder="例: 総務部" />
            <LabeledField label="担当者名（入れると「様」、空なら「御中」）" value={form.recipient.contactName} onChange={(v) => setRecipient("contactName", v)} placeholder="例: 山田 太郎" />
            {form.kind === "fax" && (
              <>
                <LabeledField label="宛先のFAX番号" value={form.recipient.fax} onChange={(v) => setRecipient("fax", v)} placeholder="例: 03-1234-5679" type="tel" />
                <LabeledField label="宛先の電話番号" value={form.recipient.tel} onChange={(v) => setRecipient("tel", v)} placeholder="例: 03-1234-5678" type="tel" />
              </>
            )}
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
      </SettingsStack>
    </PreviewSplitLayout>
  );
}

/** 画面のプレビュー（PDFと同じ並び・同じ文面） */
export function CoverLetterPreview({ form }: { form: CoverLetterForm }) {
  const to = recipientLines(form.recipient);
  const from = senderLines(form.sender);
  const items = itemLines(form.items);
  const greetingLines = form.greeting.replace(/\s+$/, "").split(/\r\n|\r|\n/);
  return (
    <div data-testid="cover-letter-preview" className="aspect-[1/1.414] w-full overflow-hidden rounded-xl border border-neutral-200 bg-white p-6 text-[11px] leading-relaxed text-neutral-900 shadow-sm dark:border-neutral-800 sm:p-8 sm:text-xs">
      <p className="text-right">{formatJapaneseDate(form.date)}</p>
      <div className="mt-3">
        {to.length === 0 ? (
          <p className="text-neutral-400">（宛先）</p>
        ) : (
          to.map((line, i) => (
            <p key={i} className={i === to.length - 1 ? "inline-block border-b border-neutral-500 pr-6 text-sm font-semibold" : ""}>
              {line}
            </p>
          ))
        )}
        {form.kind === "fax" && (form.recipient.fax || form.recipient.tel) && (
          <p className="mt-1 text-neutral-600">
            {[form.recipient.fax && `FAX：${form.recipient.fax}`, form.recipient.tel && `TEL：${form.recipient.tel}`].filter(Boolean).join("　")}
          </p>
        )}
      </div>
      <div className="ml-auto mt-3 w-1/2">
        {from.length === 0 ? <p className="text-neutral-400">（差出人）</p> : from.map((line, i) => <p key={i} className={i === 0 ? "font-semibold" : ""}>{line}</p>)}
      </div>
      <p className="mt-5 text-center text-base font-bold">{coverLetterTitle(form)}</p>
      <div className="mt-3">
        {greetingLines.map((line, i) =>
          /^\s*(敬具|敬白|草々|以上)\s*$/.test(line) ? (
            <p key={i} className="text-right">{line.trim()}</p>
          ) : (
            <p key={i} className="whitespace-pre-wrap">{line || " "}</p>
          ),
        )}
      </div>
      {(items.length > 0 || (form.kind === "fax" && form.faxPages.trim())) && (
        <div className="mt-4">
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
        <div className="mt-4">
          <p>【連絡事項】</p>
          <p className="whitespace-pre-wrap pl-2">{form.notes.trim()}</p>
        </div>
      )}
      <p className="mt-4 text-right">以上</p>
    </div>
  );
}
