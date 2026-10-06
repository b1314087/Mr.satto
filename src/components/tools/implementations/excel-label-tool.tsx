"use client";

import { useMemo, useState } from "react";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { SliderField } from "@/components/common/slider-field";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  DEFAULT_CONTENT,
  DEFAULT_GEOMETRY,
  DEFAULT_STYLE,
  LABEL_FONTS,
  LABEL_PAPERS,
  LABEL_PRESETS,
  buildAxisPlan,
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
  type LabelPlan,
  type LabelStyle,
  type LabelVAlign,
} from "@/lib/label/layout";
import { LabelWordProcessor } from "@/lib/processors/browser/label-word";
import { ExcelLabelProcessor } from "@/lib/processors/browser/excel-label";
import { downloadBlob } from "@/lib/utils/format";
import { approxWrap } from "./shared/approx-text";

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
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              value === o.value
                ? "bg-blue-600 text-white"
                : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
            }`}
          >
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
  const innerW = g.labelWidthMm - 2 * s.paddingMm;
  const innerH = g.labelHeightMm - 2 * s.paddingMm;
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

  const validationError = validateGeometry(geometry) ?? validateStyle(style) ?? validateContent(content, geometry);
  const perPage = labelsPerPage(geometry);
  const entryCount = useMemo(
    () => (content.mode === "different" ? parseLabelEntries(content.listText, content.splitMode).length : 0),
    [content.mode, content.listText, content.splitMode]
  );

  const plan: LabelPlan | null = useMemo(() => {
    if (validationError) return null;
    try {
      return planLabelPages(geometry, content);
    } catch {
      return null;
    }
  }, [geometry, content, validationError]);

  const paper = paperSizeMm(geometry.paper, geometry.landscape);
  const used = validateGeometry(geometry) ? null : usedSizeMm(geometry);
  const safePage = plan ? Math.min(pageIndex, plan.pages.length - 1) : 0;
  const pageLabels = plan?.pages[safePage] ?? null;

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
  const fontCqw = (style.fontSizePt * PT_TO_MM * 100) / paper.widthMm;
  const justify = style.vAlign === "top" ? "flex-start" : style.vAlign === "bottom" ? "flex-end" : "center";

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
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
      </section>

      <section className="flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <p className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">用紙とラベルの大きさ</p>
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
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <p className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">ラベルの内容</p>
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
        {content.mode === "same" ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-600 dark:text-neutral-300">ラベル内の文字（すべてのラベルに同じ内容が入ります）</span>
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
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-neutral-600 dark:text-neutral-300">ラベルの区切り方</span>
                <select
                  aria-label="ラベルの区切り方"
                  value={content.splitMode}
                  onChange={(e) => updateContent({ splitMode: e.target.value as LabelContent["splitMode"] })}
                  className={FIELD_CLASS}
                >
                  <option value="blank">空行で区切る（1枚が複数行になる宛名など）</option>
                  <option value="line">1行を1枚にする（Excelの行を貼り付け可・列は改行に）</option>
                </select>
              </label>
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
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {entryCount}件のラベルを読み取りました
              {plan ? `（全${plan.pages.length}ページ）` : ""}。1ページに入りきらない分は、次のページに続けて作成します。
            </p>
          </>
        )}
      </section>

      <section className="flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <p className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">文字とレイアウト</p>
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
          <SliderField
            label="ラベル内の余白"
            value={style.paddingMm}
            min={0}
            max={15}
            step={0.5}
            unit="mm"
            onChange={(v) => updateStyle({ paddingMm: v })}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-600 dark:text-neutral-300">書体</span>
            <select
              aria-label="書体"
              value={style.fontKey}
              onChange={(e) => updateStyle({ fontKey: e.target.value as LabelStyle["fontKey"] })}
              className={FIELD_CLASS}
            >
              {LABEL_FONTS.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
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
      </section>

      <section
        aria-label="ラベルシートのプレビュー"
        data-testid="tool-preview"
        className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            ラベルシートのプレビュー(設定の変更に合わせて更新されます)
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
                          padding: `${(style.paddingMm / paper.widthMm) * 100}cqw`,
                          border: overflow ? "1px solid #dc2626" : style.border ? "1px solid #9ca3af" : "1px dashed #e5e7eb",
                          background: overflow ? "#fef2f2" : undefined,
                          textAlign: style.hAlign,
                          fontFamily: font.css,
                          fontWeight: style.bold ? 700 : 400,
                          fontSize: `${fontCqw}cqw`,
                          lineHeight: 1.3 * (style.lineSpacingPct / 100),
                        }}
                      >
                        <span className="whitespace-pre-wrap break-all">{text}</span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
            {overflowCount > 0 && (
              <p role="status" className="text-xs text-amber-700 dark:text-amber-400">
                赤い枠のラベルは、文字が枠に収まらない可能性があります（約{overflowCount}枚）。文字の大きさを小さくするか、ラベル内の余白を減らしてください。
              </p>
            )}
            <p className="text-xs text-neutral-400 dark:text-neutral-500">
              用紙（{paper.widthMm}×{paper.heightMm}mm）の中のラベルの位置・大きさをmmの比率どおりに描いた配置イメージです。
              文字の収まり具合は目安で、実際の折り返しはWord・Excel側で決まります。枠線を印刷しない設定のときは、ラベルの範囲を点線で示しています。
            </p>
          </>
        ) : (
          <p className="text-xs text-neutral-400">設定が正しくないため、プレビューを表示できません。</p>
        )}
      </section>

      {validationError && <ErrorMessage message={validationError} />}

      <button
        type="button"
        onClick={handleRun}
        disabled={status === "processing" || !!validationError}
        className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
      >
        {format === "word" ? "Wordを作成" : "Excelを作成"}
      </button>

      <ProcessingStatus state={status} successLabel="ラベルシートを作成しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{result.pageCount}ページ分のラベルシートができました。</p>
          <RewardedDownloadGate
            onDownload={handleDownload}
            label={result.format === "word" ? "Wordファイルをダウンロード" : "Excelファイルをダウンロード"}
          />
        </div>
      )}
    </div>
  );
}
