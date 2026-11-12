"use client";

import { CsvEncodingControl } from "@/components/common/csv-encoding-control";
import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { useMemo, useState } from "react";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { SliderField } from "@/components/common/slider-field";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import {
  DEFAULT_CONTENT,
  DEFAULT_GEOMETRY,
  DEFAULT_STYLE,
  LABEL_FONTS,
  LABEL_PAPERS,
  LABEL_PRESETS,
  LABEL_OFFSET_MAX_MM,
  buildAxisPlan,
  labelTextOffset,
  labelsPerPage,
  paperSizeMm,
  parseLabelEntries,
  planLabelPages,
  usedSizeMm,
  validateContent,
  validateGeometry,
  validateStyle,
  type LabelContent,
  type LabelGeometry,
  type LabelHAlign,
  type LabelHonorific,
  type LabelHonorificLine,
  type LabelPostalCode,
  type LabelPlan,
  type LabelStyle,
  type LabelVAlign,
} from "@/lib/label/layout";
import { LabelWordProcessor } from "@/lib/processors/browser/label-word";
import { ExcelLabelProcessor } from "@/lib/processors/browser/excel-label";
import { downloadBlob } from "@/lib/utils/format";
import { approxWrap } from "./shared/approx-text";
import { FileDropzone } from "@/components/common/file-dropzone";
import { LABEL_IMPORT_ACCEPT, honorificLineFromHeader, readLabelImportFile, rowsToLabelListText, type LabelImportData } from "@/lib/label/import-file";
import { SettingsSection, SettingsStack } from "@/components/ui/settings-section";
import { RunBar } from "@/components/ui/run-bar";

type OutputFormat = "word" | "excel";

const FIELD_CLASS =
  "rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900";

function NumberField({
  label,
  value,
  onChange,
  min = 0,
  step = 0.1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  step?: number;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-neutral-600 dark:text-neutral-300">{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : ""}
        min={min}
        step={step}
        onChange={(e) => onChange(e.target.valueAsNumber)}
        className={FIELD_CLASS}
      />
    </label>
  );
}

function ChoiceButtons<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">{label}</p>
      {/* 見た目は全ページ共通のセグメントボタン（.ms-seg）。押している状態は aria-pressed */}
      <div className="ms-seg">
        {options.map((o) => (
          <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const PT_TO_MM = 25.4 / 72;

/** プレビュー用の目安: ラベルから文字がはみ出しそうか(実際の折り返しはWord/Excel側で決まる) */
function labelMayOverflow(text: string, g: LabelGeometry, s: LabelStyle): boolean {
  if (text === "") return false;
  const sizeMm = s.fontSizePt * PT_TO_MM;
  // 文字の位置を動かした分だけ、文字を置ける幅・高さが減る
  const offset = labelTextOffset(s);
  const innerW = g.labelWidthMm - Math.abs(offset.dxMm) * (s.hAlign === "center" ? 2 : 1);
  const innerH = g.labelHeightMm - Math.abs(offset.dyMm) * (s.vAlign === "middle" ? 2 : 1);
  if (innerW <= 0 || innerH <= 0) return true;
  const lines = approxWrap(text, sizeMm * (s.bold ? 1.05 : 1), innerW);
  return lines.length * sizeMm * 1.3 * (s.lineSpacingPct / 100) > innerH;
}

/**
 * ラベル作成。Word(推奨)またはExcelで、ラベル用紙に合わせた寸法のシートを作る。
 * 全ラベルに同じ内容を入れる／ラベルごとに違う内容を入れる、を選べ、文字の大きさ・書体・位置なども変えられる。
 */
export function ExcelLabelTool() {
  const [format, setFormat] = useState<OutputFormat>("word");
  const [geometry, setGeometry] = useState<LabelGeometry>(DEFAULT_GEOMETRY);
  const [style, setStyle] = useState<LabelStyle>(DEFAULT_STYLE);
  const [content, setContent] = useState<LabelContent>(DEFAULT_CONTENT);
  const [pageIndex, setPageIndex] = useState(0);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ blob: Blob; format: OutputFormat; pageCount: number } | null>(null);
  // Excel・CSVのファイルから読み込んだ内容（1行目を見出しとして除くかを、あとから切り替えられるように残す）
  const [imported, setImported] = useState<LabelImportData | null>(null);
  const [skipHeader, setSkipHeader] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  /** 最後に読み込んだファイル（CSVの文字コードを選び直したら、同じファイルを読み込み直す） */
  const [importedFile, setImportedFile] = useState<File | null>(null);

  function resetResult() {
    setResult(null);
    setStatus("idle");
  }

  function updateGeometry(patch: Partial<LabelGeometry>) {
    setGeometry((prev) => ({ ...prev, ...patch }));
    resetResult();
  }
  function updateStyle(patch: Partial<LabelStyle>) {
    setStyle((prev) => ({ ...prev, ...patch }));
    resetResult();
  }
  function updateContent(patch: Partial<LabelContent>) {
    setContent((prev) => ({ ...prev, ...patch }));
    resetResult();
  }

  /** 読み込んだ行を、ラベルごとの文字（1行を1枚・セルはラベルの中で改行）として入力欄へ入れる */
  function applyImport(data: LabelImportData, skip: boolean) {
    const { text } = rowsToLabelListText(data.rows, skip);
    updateContent({ mode: "different", splitMode: "line", listText: text });
    setPageIndex(0);
  }

  async function handleImportFile(files: File[]) {
    setImportedFile(files[0] ?? null);
    const file = files[0];
    if (!file) return;
    setImportError(null);
    try {
      const data = await readLabelImportFile(file);
      setImported(data);
      setSkipHeader(data.headerLikely);
      applyImport(data, data.headerLikely);
      // 見出しに「氏名」「会社名」などがあれば、その列の位置に合わせて、敬称を付ける行を選んでおく
      const line = data.headerLikely ? honorificLineFromHeader(data.rows[0]) : null;
      if (line) updateContent({ honorificLine: line });
    } catch (e) {
      setImportError(e instanceof Error ? e.message : "ファイルを読み込めませんでした");
    }
  }

  const geometryError = validateGeometry(geometry);
  const contentError = geometryError ? null : validateContent(content, geometry);
  const validationError = geometryError ?? validateStyle(style) ?? contentError;
  const perPage = labelsPerPage(geometry);
  const entryCount = useMemo(
    () => (content.mode === "different" ? parseLabelEntries(content.listText, content.splitMode).length : 0),
    [content.mode, content.listText, content.splitMode]
  );

  const plan: LabelPlan | null = useMemo(() => {
    // 文字の設定（大きさなど）の誤りでは、ラベルの並びは変わらないため、プレビューは隠さない
    if (geometryError || contentError) return null;
    try {
      return planLabelPages(geometry, content);
    } catch {
      return null;
    }
  }, [geometry, content, geometryError, contentError]);

  const paper = paperSizeMm(geometry.paper, geometry.landscape);
  const used = validateGeometry(geometry) ? null : usedSizeMm(geometry);
  const safePage = plan ? Math.min(pageIndex, plan.pages.length - 1) : 0;
  // 用紙・ラベルの大きさが正しければ、内容がまだ入っていなくても、空のラベルでシートを表示する
  // （以前は内容のエラーでもプレビュー全体を隠していたため、「ラベルごとに違う内容」で文字が空のとき何も表示されなかった）
  const pageLabels = plan?.pages[safePage] ?? (geometryError ? null : Array.from({ length: perPage }, () => ""));

  const placed = useMemo(() => {
    if (validateGeometry(geometry)) return null;
    const place = (p: ReturnType<typeof buildAxisPlan>) => {
      let offset = 0;
      const labels: { start: number; size: number }[] = [];
      for (const seg of p) {
        if (seg.kind === "label") labels.push({ start: offset, size: seg.mm });
        offset += seg.mm;
      }
      return labels;
    };
    return {
      rows: place(buildAxisPlan(geometry.rows, geometry.labelHeightMm, geometry.gapVMm, geometry.marginTopMm)),
      cols: place(buildAxisPlan(geometry.columns, geometry.labelWidthMm, geometry.gapHMm, geometry.marginLeftMm)),
    };
  }, [geometry]);

  const overflowCount = useMemo(() => {
    if (!plan) return 0;
    let n = 0;
    for (const page of plan.pages) for (const t of page) if (labelMayOverflow(t, geometry, style)) n++;
    return n;
  }, [plan, geometry, style]);

  async function handleRun() {
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const settings = { geometry, style, content };
      const output =
        format === "word" ? await new LabelWordProcessor().process(settings) : await new ExcelLabelProcessor().process(settings);
      setResult({ blob: output.blob, format, pageCount: output.pageCount });
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!result) return;
    downloadBlob(result.blob, result.format === "word" ? "ラベルシート.docx" : "ラベルシート.xlsx");
  }

  const font = LABEL_FONTS.find((f) => f.key === style.fontKey) ?? LABEL_FONTS[0];
  const textOffset = labelTextOffset(style);
  const fontCqw = (style.fontSizePt * PT_TO_MM * 100) / paper.widthMm;
  const justify = style.vAlign === "top" ? "flex-start" : style.vAlign === "bottom" ? "flex-end" : "center";

  return (
    <PreviewSplitLayout
      previewWidth="md"
      preview={
      <section
        aria-label="ラベルシートのプレビュー"
        data-testid="tool-preview"
        className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            プレビュー
          </p>
          {plan && plan.pages.length > 1 && (
            <div className="flex items-center gap-2 text-sm">
              <button
                type="button"
                onClick={() => setPageIndex(Math.max(0, safePage - 1))}
                disabled={safePage === 0}
                className="rounded-md px-2.5 py-1 ring-1 ring-neutral-300 disabled:opacity-40 dark:ring-neutral-700"
              >
                前のページ
              </button>
              <span className="tabular-nums" data-testid="label-page-indicator">
                {safePage + 1} / {plan.pages.length}ページ
              </span>
              <button
                type="button"
                onClick={() => setPageIndex(Math.min(plan.pages.length - 1, safePage + 1))}
                disabled={safePage >= plan.pages.length - 1}
                className="rounded-md px-2.5 py-1 ring-1 ring-neutral-300 disabled:opacity-40 dark:ring-neutral-700"
              >
                次のページ
              </button>
            </div>
          )}
        </div>
        {placed && pageLabels ? (
          <>
            <div className="w-full max-w-md" style={{ containerType: "inline-size" }}>
              <div
                className="relative w-full overflow-hidden rounded border border-neutral-300 bg-white shadow-sm dark:border-neutral-600"
                style={{ aspectRatio: `${paper.widthMm} / ${paper.heightMm}` }}
              >
                {placed.rows.map((r, ri) =>
                  placed.cols.map((c, ci) => {
                    const text = pageLabels[ri * placed.cols.length + ci] ?? "";
                    const overflow = labelMayOverflow(text, geometry, style);
                    return (
                      <div
                        key={`${ri}-${ci}`}
                        data-testid="label-cell"
                        className="absolute flex flex-col overflow-hidden text-neutral-900"
                        style={{
                          left: `${(c.start / paper.widthMm) * 100}%`,
                          top: `${(r.start / paper.heightMm) * 100}%`,
                          width: `${(c.size / paper.widthMm) * 100}%`,
                          height: `${(r.size / paper.heightMm) * 100}%`,
                          justifyContent: justify,
                          padding: 0,
                          border: overflow ? "1px solid #dc2626" : style.border ? "1px solid #9ca3af" : "1px dashed #e5e7eb",
                          background: overflow ? "#fef2f2" : undefined,
                          textAlign: style.hAlign,
                          fontFamily: font.css,
                          fontWeight: style.bold ? 700 : 400,
                          fontSize: `${fontCqw}cqw`,
                          lineHeight: 1.3 * (style.lineSpacingPct / 100),
                        }}
                      >
                        <span
                          className="whitespace-pre-wrap break-all"
                          style={{ transform: `translate(${(textOffset.dxMm / paper.widthMm) * 100}cqw, ${(textOffset.dyMm / paper.widthMm) * 100}cqw)` }}
                        >
                          {text}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
            {overflowCount > 0 && (
              <p role="status" className="text-xs text-amber-700 dark:text-amber-400">
                赤い枠のラベルは、文字が枠に収まらない可能性があります（約{overflowCount}枚）。文字の大きさを小さくするか、文字の位置の調整を0に近づけてください。
              </p>
            )}
            {!plan && contentError && (
              <p className="text-xs text-neutral-500 dark:text-neutral-400" data-testid="label-preview-hint">
                {content.mode === "different" && entryCount === 0
                  ? "ラベルに入れる文字を入力するか、Excel・CSVのファイルを読み込むと、ここに表示されます。"
                  : `${contentError}。`}
              </p>
            )}
            <p className="text-xs text-neutral-400 dark:text-neutral-500">文字の収まり具合は目安です。実際の折り返しはWord・Excel側で決まります。</p>
          </>
        ) : (
          <p className="text-xs text-neutral-500 dark:text-neutral-400" data-testid="label-preview-hint">
            {geometryError ? `${geometryError}。直すとプレビューが表示されます。` : "プレビューを表示できません。"}
          </p>
        )}
      </section>
      }
    >
      <SettingsStack testId="label-settings">
        <SettingsSection n={1} title="ラベルの内容（Excel・CSVの取り込み）" testId="label-section-content" bodyClassName="gap-3">
          <FileDropzone
            compact={!!importedFile}
            accept={LABEL_IMPORT_ACCEPT}
            label="Excel・CSVのファイルをドラッグ&ドロップ"
            hint="またはタップして選択（.xlsx・.csv）。1行が1枚のラベルになり、横に並んだセルはラベルの中で改行されます"
            onFilesSelected={handleImportFile}
            onError={setImportError}
          />
          <CsvEncodingControl files={[importedFile]} onChange={(f) => void handleImportFile([f])} />
          {importError && <ErrorMessage message={importError} />}
          {imported && (
            <div className="flex flex-col gap-1.5 rounded-lg bg-neutral-50 px-3 py-2 text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300" data-testid="label-import-info">
              <p>
                「{imported.fileName}」{imported.sheetName ? `（シート: ${imported.sheetName}）` : ""}から
                {rowsToLabelListText(imported.rows, skipHeader).count}件を読み込みました。読み込んだ内容は、下の欄で直せます。
              </p>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={skipHeader}
                  onChange={(e) => {
                    setSkipHeader(e.target.checked);
                    applyImport(imported, e.target.checked);
                  }}
                />
                1行目は見出し（「氏名」「住所」など）なので、ラベルにしない
              </label>
            </div>
          )}
          <ChoiceButtons
            label="ラベルに入れる内容"
            value={content.mode}
            options={[
              { value: "same", label: "全ラベル同じ内容" },
              { value: "different", label: "ラベルごとに違う内容" },
            ]}
            onChange={(v) => {
              updateContent({ mode: v });
              setPageIndex(0);
            }}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <ChoiceButtons<LabelHonorific>
              label="敬称"
              value={content.honorific ?? "none"}
              options={[
                { value: "none", label: "なし" },
                { value: "sama", label: "様" },
                { value: "onchu", label: "御中" },
              ]}
              onChange={(v) => updateContent({ honorific: v })}
            />
            {(content.honorific ?? "none") !== "none" && (
              <ChoiceButtons<LabelHonorificLine>
                label="敬称を付ける行"
                value={content.honorificLine ?? "last"}
                options={[
                  { value: "last", label: "最後の行（〒・住所・名前の順）" },
                  { value: "first", label: "1行目（名前・住所の順）" },
                ]}
                onChange={(v) => updateContent({ honorificLine: v })}
              />
            )}
          </div>
          {(content.honorific ?? "none") !== "none" && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              個人あては「様」、会社・部署あては「御中」です。すでに「様」「御中」「殿」が付いている行には、重ねて付けません。
            </p>
          )}
          <ChoiceButtons<LabelPostalCode>
            label="郵便番号"
            value={content.postalCode ?? "keep"}
            options={[
              { value: "keep", label: "入力のまま" },
              { value: "mark", label: "〒マークを付ける" },
              { value: "remove", label: "入れない" },
            ]}
            onChange={(v) => updateContent({ postalCode: v })}
          />
          {(content.postalCode ?? "keep") !== "keep" && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {content.postalCode === "mark"
                ? "郵便番号の行（1000001・100-0001 など）を「〒100-0001」の形にそろえます。"
                : "郵便番号の行（〒100-0001・1000001 など）をラベルに入れません。「〒100-0001 東京都…」のように住所と同じ行にあるときは、郵便番号の部分だけを除きます。"}
            </p>
          )}
          {content.mode === "same" ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-600 dark:text-neutral-300">ラベル内の文字（全ラベル共通）</span>
              <textarea
                aria-label="ラベル内の文字"
                value={content.sameText}
                onChange={(e) => updateContent({ sameText: e.target.value })}
                rows={4}
                className={FIELD_CLASS}
              />
            </label>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <ChoiceButtons<LabelContent["splitMode"]>
                  label="ラベルの区切り方"
                  value={content.splitMode}
                  onChange={(v) => updateContent({ splitMode: v })}
                  options={[
                    { value: "blank", label: "空行で区切る" },
                    { value: "line", label: "1行を1枚にする" },
                  ]}
                />
                <NumberField
                  label={`使い始める位置（1〜${perPage}枚目）`}
                  value={content.startPosition}
                  onChange={(v) => updateContent({ startPosition: Math.round(v) })}
                  min={1}
                  step={1}
                />
              </div>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-neutral-600 dark:text-neutral-300">
                  ラベルごとの文字（{content.splitMode === "blank" ? "1枚ごとに空行を1つ入れて区切ります" : "1行が1枚のラベルになります"}）
                </span>
                <textarea
                  aria-label="ラベルごとの文字"
                  value={content.listText}
                  onChange={(e) => updateContent({ listText: e.target.value })}
                  rows={8}
                  placeholder={
                    content.splitMode === "blank"
                      ? "〒100-0001\n東京都千代田区千代田1-1\n山田 太郎 様\n\n〒530-0001\n大阪府大阪市北区梅田1-1\n佐藤 花子 様"
                      : "山田 太郎\t東京都千代田区千代田1-1\n佐藤 花子\t大阪府大阪市北区梅田1-1"
                  }
                  className={`${FIELD_CLASS} font-mono`}
                />
              </label>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">{entryCount}件のラベルを読み取りました{plan ? `（全${plan.pages.length}ページ）` : ""}</p>
            </>
          )}
        </SettingsSection>
        <SettingsSection n={2} title="用紙とラベルの大きさ" testId="label-section-paper" bodyClassName="gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-600 dark:text-neutral-300">よくあるラベル用紙から選ぶ</span>
              <select
                aria-label="よくあるラベル用紙から選ぶ"
                value=""
                onChange={(e) => {
                  const preset = LABEL_PRESETS.find((p) => p.id === e.target.value);
                  if (preset) updateGeometry(preset.geometry);
                }}
                className={FIELD_CLASS}
              >
                <option value="">（選択して寸法を入力）</option>
                {LABEL_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-600 dark:text-neutral-300">用紙サイズ</span>
              <select
                aria-label="用紙サイズ"
                value={geometry.paper}
                onChange={(e) => updateGeometry({ paper: e.target.value as LabelGeometry["paper"] })}
                className={FIELD_CLASS}
              >
                {LABEL_PAPERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <ChoiceButtons
              label="用紙の向き"
              value={geometry.landscape ? "landscape" : "portrait"}
              options={[
                { value: "portrait", label: "縦" },
                { value: "landscape", label: "横" },
              ]}
              onChange={(v) => updateGeometry({ landscape: v === "landscape" })}
            />
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <NumberField label="ラベル幅 (mm)" value={geometry.labelWidthMm} onChange={(v) => updateGeometry({ labelWidthMm: v })} />
            <NumberField label="ラベル高さ (mm)" value={geometry.labelHeightMm} onChange={(v) => updateGeometry({ labelHeightMm: v })} />
            <NumberField label="列数" value={geometry.columns} onChange={(v) => updateGeometry({ columns: Math.round(v) })} min={1} step={1} />
            <NumberField label="行数" value={geometry.rows} onChange={(v) => updateGeometry({ rows: Math.round(v) })} min={1} step={1} />
            <NumberField label="横の間隔 (mm)" value={geometry.gapHMm} onChange={(v) => updateGeometry({ gapHMm: v })} />
            <NumberField label="縦の間隔 (mm)" value={geometry.gapVMm} onChange={(v) => updateGeometry({ gapVMm: v })} />
            <NumberField label="上の余白 (mm)" value={geometry.marginTopMm} onChange={(v) => updateGeometry({ marginTopMm: v })} />
            <NumberField label="左の余白 (mm)" value={geometry.marginLeftMm} onChange={(v) => updateGeometry({ marginLeftMm: v })} />
          </div>
          {used && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              1ページ {perPage}枚（{geometry.columns}列×{geometry.rows}行）。右の余り {Math.round((paper.widthMm - used.widthMm) * 10) / 10}mm・下の余り{" "}
              {Math.round((paper.heightMm - used.heightMm) * 10) / 10}mm
            </p>
          )}
        </SettingsSection>
        <SettingsSection n={3} title="文字とレイアウト" testId="label-section-style" bodyClassName="gap-4">
          <SliderField
            label="文字の大きさ"
            value={style.fontSizePt}
            min={6}
            max={72}
            inputMax={300}
            unit="pt"
            onChange={(v) => updateStyle({ fontSizePt: v })}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <SliderField
              label="行の間隔"
              value={style.lineSpacingPct}
              min={80}
              max={200}
              step={5}
              unit="%"
              onChange={(v) => updateStyle({ lineSpacingPct: v })}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <SliderField
              label="文字の位置（横）"
              value={style.offsetXMm}
              min={-LABEL_OFFSET_MAX_MM}
              max={LABEL_OFFSET_MAX_MM}
              step={0.5}
              unit="mm"
              onChange={(v) => updateStyle({ offsetXMm: v })}
              onReset={() => updateStyle({ offsetXMm: 0 })}
              hint={
                style.hAlign === "left"
                  ? "左揃えのときは右（プラス）へだけ動かせます。"
                  : style.hAlign === "right"
                    ? "右揃えのときは左（マイナス）へだけ動かせます。"
                    : "プラスで右へ、マイナスで左へ動きます。"
              }
            />
            <SliderField
              label="文字の位置（縦）"
              value={style.offsetYMm}
              min={-LABEL_OFFSET_MAX_MM}
              max={LABEL_OFFSET_MAX_MM}
              step={0.5}
              unit="mm"
              onChange={(v) => updateStyle({ offsetYMm: v })}
              onReset={() => updateStyle({ offsetYMm: 0 })}
              hint={
                style.vAlign === "top"
                  ? "上揃えのときは下（プラス）へだけ動かせます。"
                  : style.vAlign === "bottom"
                    ? "下揃えのときは上（マイナス）へだけ動かせます。"
                    : "プラスで下へ、マイナスで上へ動きます。"
              }
            />
          </div>
          {format === "excel" && (style.offsetXMm !== 0 || style.offsetYMm !== 0) && (
            <p className="text-xs text-amber-700 dark:text-amber-400">文字の位置の調整は、Wordで作成したときだけ反映されます（Excelには反映されません）。</p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <ChoiceButtons<LabelStyle["fontKey"]>
              label="書体"
              value={style.fontKey}
              onChange={(v) => updateStyle({ fontKey: v })}
              options={LABEL_FONTS.map((f) => ({ value: f.key, label: f.label }))}
            />
            <label className="flex items-center gap-2 self-end pb-2 text-sm text-neutral-700 dark:text-neutral-200">
              <input type="checkbox" checked={style.bold} onChange={(e) => updateStyle({ bold: e.target.checked })} />
              太字にする
            </label>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <ChoiceButtons<LabelHAlign>
              label="横の位置"
              value={style.hAlign}
              options={[
                { value: "left", label: "左" },
                { value: "center", label: "中央" },
                { value: "right", label: "右" },
              ]}
              onChange={(v) => updateStyle({ hAlign: v })}
            />
            <ChoiceButtons<LabelVAlign>
              label="縦の位置"
              value={style.vAlign}
              options={[
                { value: "top", label: "上" },
                { value: "middle", label: "中央" },
                { value: "bottom", label: "下" },
              ]}
              onChange={(v) => updateStyle({ vAlign: v })}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
            <input type="checkbox" checked={style.border} onChange={(e) => updateStyle({ border: e.target.checked })} />
            ラベルの枠線を印刷する（シールに直接印刷するときは外します）
          </label>
        </SettingsSection>
        <SettingsSection n={4} title="出力するファイルの形式" testId="label-section-format" bodyClassName="gap-3">
          <ChoiceButtons
            label="出力するファイルの形式"
            value={format}
            options={[
              { value: "word", label: "Word（おすすめ）" },
              { value: "excel", label: "Excel" },
            ]}
            onChange={(v) => {
              setFormat(v);
              resetResult();
            }}
          />
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {format === "word"
              ? "Wordは用紙サイズ・余白・ラベルの大きさをmm通りに指定でき、ラベル用紙にそのまま印刷しやすい形式です。"
              : "Excelは列幅が「文字数」という単位の近似になるため、mmの寸法が多少ずれます。用紙サイズはExcelの印刷設定で合わせてください。"}
          </p>
        </SettingsSection>
      </SettingsStack>


      {validationError && <ErrorMessage message={validationError} />}

      <RunBar>
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing" || !!validationError} aria-busy={status === "processing" || undefined}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {format === "word" ? "Wordを作成" : "Excelを作成"}
        </button>
      </RunBar>

      <ProcessingStatus state={status} successLabel="ラベルシートを作成しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <ResultPopup>
          <RewardedDownloadGate
            onDownload={handleDownload}
            label={result.format === "word" ? "Wordファイルをダウンロード" : "Excelファイルをダウンロード"}
          />
        </ResultPopup>
      )}
    </PreviewSplitLayout>
  );
}
