"use client";

import { useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  arrangeSeating,
  evaluateConstraints,
  parseRuleNames,
  swapSeats,
  totalSeats,
  validatePlan,
  shortageMessage,
  type BalanceMode,
  type SeatingConstraints,
  type SeatingPlan,
  type SeatRef,
} from "@/lib/seating/arrange";
import {
  namesFromRows,
  parseParticipants,
  SEATING_MAX_PARTICIPANTS,
  SEATING_MAX_SEATS_PER_TABLE,
  SEATING_MAX_TABLES,
  type Participant,
} from "@/lib/seating/participants";
import { seatingToCsvBlob, seatingToPdfBlob, seatingToXlsxBlob } from "@/lib/processors/browser/seating-export";
import { classifyMergeFile, loadMergeFile, MERGE_FILE_ACCEPT, MERGE_LEGACY_EXCEL_MESSAGE, MERGE_UNSUPPORTED_MESSAGE } from "@/lib/processors/browser/excel-merge";
import { downloadBlob, sanitizeFileName } from "@/lib/utils/format";

interface FixedRow {
  name: string;
  table: string;
  seat: string;
}

interface Generated {
  plan: SeatingPlan;
  participants: Participant[];
  tableSizes: number[];
  constraints: SeatingConstraints;
  inputsKey: string;
  edited: boolean;
}

const DEFAULT_TITLE = "座席表";

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

const inputClass =
  "rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100";
const smallButton =
  "rounded-lg bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-200 disabled:opacity-40 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700";
const sectionClass = "flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800";

/** 座席表作成。参加者の名簿から、条件（同席・別席・固定）に沿った席順を作り、手で調整して、PDF・Excel・CSVで保存する */
export function SeatingChartTool() {
  const [namesText, setNamesText] = useState("");
  const [keepDuplicates, setKeepDuplicates] = useState(false);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [tableCount, setTableCount] = useState(4);
  const [seatsPerTable, setSeatsPerTable] = useState(8);
  const [customSizes, setCustomSizes] = useState(false);
  const [sizeOverrides, setSizeOverrides] = useState<Record<number, number>>({});
  const [balance, setBalance] = useState<BalanceMode>("even");

  const [together, setTogether] = useState<string[]>([]);
  const [apart, setApart] = useState<string[]>([]);
  const [fixed, setFixed] = useState<FixedRow[]>([]);

  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [generated, setGenerated] = useState<Generated | null>(null);
  const [selected, setSelected] = useState<SeatRef | null>(null);
  const [arrangeErrors, setArrangeErrors] = useState<string[]>([]);
  const [confirmRedraw, setConfirmRedraw] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const parsed = useMemo(() => parseParticipants(namesText, { keepDuplicates }), [namesText, keepDuplicates]);
  const tableSizes = useMemo(
    () => Array.from({ length: tableCount }, (_, i) => (customSizes ? (sizeOverrides[i] ?? seatsPerTable) : seatsPerTable)),
    [tableCount, seatsPerTable, customSizes, sizeOverrides]
  );
  const seats = totalSeats(tableSizes);
  const people = parsed.participants.length;
  const shortBy = people - seats;

  const constraints: SeatingConstraints = useMemo(
    () => ({
      together: together.map(parseRuleNames),
      apart: apart.map(parseRuleNames),
      fixed: fixed
        .filter((f) => f.name.trim() !== "")
        .map((f) => ({
          name: f.name.trim(),
          table: Number(f.table),
          seat: f.seat.trim() === "" ? undefined : Number(f.seat),
        })),
    }),
    [together, apart, fixed]
  );

  const inputsKey = JSON.stringify([parsed.participants.map((p) => p.name), tableSizes, balance, constraints]);
  const stale = generated !== null && generated.inputsKey !== inputsKey;

  const violations = useMemo(
    () => (generated ? evaluateConstraints(generated.plan, generated.participants, generated.constraints) : []),
    [generated]
  );
  const planErrors = useMemo(
    () => (generated ? validatePlan(generated.plan, generated.participants, generated.tableSizes) : []),
    [generated]
  );

  async function handleFile(files: File[]) {
    const file = files[0];
    setUploadNote(null);
    setUploadError(null);
    const kind = classifyMergeFile(file);
    if (kind === "legacy-excel") return setUploadError(MERGE_LEGACY_EXCEL_MESSAGE);
    if (kind === "unsupported") return setUploadError(MERGE_UNSUPPORTED_MESSAGE);
    try {
      const loaded = await loadMergeFile(file);
      const sheet = loaded.sheets[0];
      const { names, column, hadHeader } = namesFromRows(sheet.rows);
      const added = names.filter((n) => n.trim() !== "");
      if (added.length === 0) return setUploadError("名前が見つかりませんでした。名前が1列に並んだファイルを選んでください（1行目に「氏名」などの見出しがあると、その列を読み込みます）。");
      setNamesText((prev) => (prev.trim() === "" ? added.join("\n") : `${prev.replace(/\s+$/, "")}\n${added.join("\n")}`));
      const where = hadHeader ? `「${String(sheet.rows.find((r) => r.length > 0)?.[column] ?? "")}」の列` : "1列目";
      setUploadNote(`${file.name}から、${where}の${added.length}件を名簿に追加しました。${loaded.sheets.length > 1 ? "シートが複数あるため、先頭のシートを読み込みました。" : ""}`);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "ファイルを読み込めませんでした");
    }
  }

  function runArrange() {
    setConfirmRedraw(false);
    setSelected(null);
    const seed = Math.floor(Math.random() * 2 ** 31);
    const result = arrangeSeating(parsed.participants, { tableSizes, balance }, constraints, seed);
    if (!result.ok) {
      setArrangeErrors(result.reason === "shortage" ? [result.message] : result.messages);
      return;
    }
    setArrangeErrors([]);
    setGenerated({
      plan: result.plan,
      participants: parsed.participants,
      tableSizes,
      constraints,
      inputsKey,
      edited: false,
    });
  }

  function handleArrangeClick() {
    if (generated?.edited && !confirmRedraw) {
      setConfirmRedraw(true);
      return;
    }
    runArrange();
  }

  function handleSeatClick(ref: SeatRef) {
    if (!generated) return;
    const occupant = generated.plan.tables[ref.table][ref.seat];
    if (!selected) {
      if (occupant !== null) setSelected(ref);
      return;
    }
    if (selected.table === ref.table && selected.seat === ref.seat) {
      setSelected(null);
      return;
    }
    const plan = swapSeats(generated.plan, selected, ref);
    setGenerated({ ...generated, plan, edited: true });
    setSelected(null);
  }

  async function exportAs(kind: "pdf" | "xlsx" | "csv") {
    if (!generated) return;
    setExportError(null);
    setExporting(true);
    try {
      const input = { title, participants: generated.participants, plan: generated.plan };
      const base = sanitizeFileName(title.trim() === "" ? DEFAULT_TITLE : title.trim());
      if (kind === "pdf") downloadBlob((await seatingToPdfBlob(input)).blob, `${base}.pdf`);
      else if (kind === "xlsx") downloadBlob(await seatingToXlsxBlob(input), `${base}.xlsx`);
      else downloadBlob(seatingToCsvBlob(input), `${base}.csv`);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "ファイルを作成できませんでした");
    } finally {
      setExporting(false);
    }
  }

  const nameById = new Map((generated?.participants ?? []).map((p) => [p.id, p.name]));

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        入力した名前や名簿は、このブラウザの中だけで処理します。サーバーへの送信や保存はしません。
      </p>

      {/* 1. 参加者 */}
      <section className={sectionClass} aria-labelledby="seating-step1">
        <h2 id="seating-step1" className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
          1. 参加者を入力する
        </h2>
        <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
          名前を1行に1人ずつ入力します（Excelの列をそのまま貼り付けられます。「、」「,」で区切っても構いません）
          <textarea
            data-testid="seating-names"
            aria-label="参加者の名前"
            value={namesText}
            onChange={(e) => setNamesText(e.target.value)}
            rows={8}
            placeholder={"山田 太郎\n佐藤 花子\n鈴木 一郎"}
            className={`${inputClass} font-normal`}
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
          <input type="checkbox" checked={keepDuplicates} onChange={(e) => setKeepDuplicates(e.target.checked)} />
          同じ名前も別の人として扱う（「山田太郎(2)」のように番号を付けます）
        </label>
        <p data-testid="seating-participant-summary" className="text-sm text-neutral-700 dark:text-neutral-200">
          参加者：{people}人
          {parsed.blankCount > 0 && people > 0 && `（空の行 ${parsed.blankCount} 件を除きました）`}
          {parsed.removedDuplicates.length > 0 && `（同じ名前 ${parsed.removedDuplicates.length} 件を除きました：${parsed.removedDuplicates.slice(0, 5).join("、")}${parsed.removedDuplicates.length > 5 ? "など" : ""}）`}
          {parsed.renamedDuplicates.length > 0 && `（同じ名前に番号を付けました：${parsed.renamedDuplicates.slice(0, 5).join("、")}${parsed.renamedDuplicates.length > 5 ? "など" : ""}）`}
        </p>
        {parsed.overLimit > 0 && (
          <ErrorMessage message={`参加者は${SEATING_MAX_PARTICIPANTS}人までです。超えた${parsed.overLimit}人は読み込んでいません。`} />
        )}
        <div className="flex flex-col gap-2">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">ファイルから追加する（CSV・Excel。名前が1列に並んだもの。1行目に「氏名」などの見出しがあれば、その列を使います）</p>
          <FileDropzone
            accept={MERGE_FILE_ACCEPT}
            maxSizeMB={10}
            label="名簿のCSV・Excelをドラッグ&ドロップ"
            hint="またはタップして選択"
            onFilesSelected={handleFile}
            onError={setUploadError}
          />
          {uploadNote && (
            <p data-testid="seating-upload-note" className="text-xs text-green-700 dark:text-green-400">
              {uploadNote}
            </p>
          )}
          {uploadError && <ErrorMessage message={uploadError} />}
        </div>
      </section>

      {/* 2. 会場 */}
      <section className={sectionClass} aria-labelledby="seating-step2">
        <h2 id="seating-step2" className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
          2. テーブルと席数を決める
        </h2>
        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
            テーブル数
            <input
              type="number"
              min={1}
              max={SEATING_MAX_TABLES}
              value={tableCount}
              onChange={(e) => setTableCount(clampInt(Number(e.target.value), 1, SEATING_MAX_TABLES))}
              className={`${inputClass} w-24`}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
            1テーブルの席数
            <input
              type="number"
              min={1}
              max={SEATING_MAX_SEATS_PER_TABLE}
              value={seatsPerTable}
              onChange={(e) => setSeatsPerTable(clampInt(Number(e.target.value), 1, SEATING_MAX_SEATS_PER_TABLE))}
              className={`${inputClass} w-24`}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
            空席の分け方
            <select
              value={balance}
              onChange={(e) => setBalance(e.target.value as BalanceMode)}
              className={inputClass}
            >
              <option value="even">各テーブルに均等に（空席も均等に）</option>
              <option value="fill">1番のテーブルから順に詰める</option>
            </select>
          </label>
        </div>
        <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
          <input type="checkbox" checked={customSizes} onChange={(e) => setCustomSizes(e.target.checked)} />
          テーブルごとに席数を変える
        </label>
        {customSizes && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {tableSizes.map((size, i) => (
              <label key={i} className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                テーブル{i + 1}の席数
                <input
                  type="number"
                  min={1}
                  max={SEATING_MAX_SEATS_PER_TABLE}
                  value={size}
                  onChange={(e) =>
                    setSizeOverrides((prev) => ({ ...prev, [i]: clampInt(Number(e.target.value), 1, SEATING_MAX_SEATS_PER_TABLE) }))
                  }
                  className={`${inputClass} w-full`}
                />
              </label>
            ))}
          </div>
        )}
        <p data-testid="seating-capacity" className="text-sm text-neutral-700 dark:text-neutral-200">
          席は全部で{seats}席、参加者は{people}人です{people > 0 && shortBy <= 0 && `（空席 ${-shortBy} 席）`}。
        </p>
        {shortBy > 0 && (
          <div data-testid="seating-shortage">
            <ErrorMessage message={shortageMessage(people, seats, tableCount, Math.max(...tableSizes))} />
          </div>
        )}
      </section>

      {/* 3. 条件 */}
      <section className={sectionClass} aria-labelledby="seating-step3">
        <h2 id="seating-step3" className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
          3. 席の条件を指定する（なくても作れます）
        </h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          名前は、名簿に入力したとおりに書きます（姓と名の間の空白の有無、全角・半角の違いは問いません）。複数の名前は「、」か「,」で区切ります。
        </p>

        <RuleList
          title="同じテーブルにしたい人"
          hint="例：山田太郎、佐藤花子"
          testId="seating-together"
          items={together}
          onChange={setTogether}
          addLabel="同じテーブルにしたい人を追加"
        />
        <RuleList
          title="別々のテーブルにしたい人（全員が、互いに別のテーブルになります）"
          hint="例：鈴木一郎、高橋次郎、田中三郎"
          testId="seating-apart"
          items={apart}
          onChange={setApart}
          addLabel="別々にしたい人を追加"
        />

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">席を固定する人（テーブル、または席まで）</p>
          <datalist id="seating-name-options">
            {parsed.participants.slice(0, 200).map((p) => (
              <option key={p.id} value={p.name} />
            ))}
          </datalist>
          {fixed.map((row, i) => (
            <div key={i} data-testid="seating-fixed-row" className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                名前
                <input
                  list="seating-name-options"
                  aria-label={`固定する人${i + 1}の名前`}
                  value={row.name}
                  onChange={(e) => setFixed((prev) => prev.map((r, k) => (k === i ? { ...r, name: e.target.value } : r)))}
                  className={`${inputClass} w-44`}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                テーブル番号
                <input
                  type="number"
                  min={1}
                  max={tableCount}
                  aria-label={`固定する人${i + 1}のテーブル番号`}
                  value={row.table}
                  onChange={(e) => setFixed((prev) => prev.map((r, k) => (k === i ? { ...r, table: e.target.value } : r)))}
                  className={`${inputClass} w-24`}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                席番号（任意）
                <input
                  type="number"
                  min={1}
                  aria-label={`固定する人${i + 1}の席番号`}
                  value={row.seat}
                  onChange={(e) => setFixed((prev) => prev.map((r, k) => (k === i ? { ...r, seat: e.target.value } : r)))}
                  className={`${inputClass} w-24`}
                />
              </label>
              <button type="button" onClick={() => setFixed((prev) => prev.filter((_, k) => k !== i))} className={smallButton}>
                固定を削除
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setFixed((prev) => [...prev, { name: "", table: "1", seat: "" }])}
            className={`${smallButton} w-fit`}
          >
            席を固定する人を追加
          </button>
        </div>
      </section>

      {/* 4. 席順 */}
      <section className={sectionClass} aria-labelledby="seating-step4">
        <h2 id="seating-step4" className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
          4. 席順を作る
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            data-testid="seating-arrange"
            onClick={handleArrangeClick}
            disabled={people === 0}
            className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {generated ? "席順を再抽選する" : "席順を作る"}
          </button>
          {generated && <span className="text-xs text-neutral-500 dark:text-neutral-400">押すたびに、別の席順になります（同じ条件のまま、何度でも作り直せます）。</span>}
        </div>
        {confirmRedraw && (
          <div
            data-testid="seating-confirm-redraw"
            className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-200"
          >
            <p>手で入れ替えた内容は、再抽選すると消えます。再抽選しますか？</p>
            <div className="flex gap-2">
              <button type="button" onClick={runArrange} className="rounded-md bg-amber-700 px-3 py-1.5 font-medium text-white hover:bg-amber-800">
                再抽選する
              </button>
              <button type="button" onClick={() => setConfirmRedraw(false)} className={smallButton}>
                やめる
              </button>
            </div>
          </div>
        )}
        {arrangeErrors.length > 0 && (
          <div data-testid="seating-errors" className="flex flex-col gap-2">
            {arrangeErrors.map((m) => (
              <ErrorMessage key={m} message={m} />
            ))}
          </div>
        )}
      </section>

      {/* 5. 結果・調整・保存 */}
      {generated && (
        <section className={sectionClass} aria-labelledby="seating-step5" data-testid="tool-preview">
          <h2 id="seating-step5" className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
            5. 席を確かめて、必要なら入れ替える
          </h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            入れ替えたい人の席を押し、次に、入れ替え先の席（空席なら移動）を押します。もう一度同じ席を押すと、選択をやめます。
          </p>
          {stale && (
            <p data-testid="seating-stale" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-200">
              名簿・席数・条件を変更しました。この席順は、変更前の内容で作ったものです。反映するには「席順を再抽選する」を押してください（手で入れ替えた内容は消えます）。
            </p>
          )}
          {generated.edited && !stale && (
            <p data-testid="seating-edited" className="text-xs text-neutral-500 dark:text-neutral-400">
              手で入れ替えた内容があります。「席順を再抽選する」を押すと消えます。
            </p>
          )}
          {violations.length > 0 && (
            <div data-testid="seating-violations" className="flex flex-col gap-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-200">
              <p className="font-semibold">守られていない条件があります</p>
              <ul className="list-disc pl-4">
                {violations.map((v) => (
                  <li key={v}>{v}</li>
                ))}
              </ul>
            </div>
          )}
          {planErrors.length > 0 && <ErrorMessage message={`席順に問題があります：${planErrors.join(" ")}`} />}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {generated.plan.tables.map((row, t) => (
              <div key={t} data-testid="seating-table" className="flex flex-col rounded-lg border border-neutral-300 dark:border-neutral-700">
                <div className="flex items-center justify-between rounded-t-lg bg-blue-50 px-3 py-1.5 text-sm font-medium text-neutral-800 dark:bg-blue-950/30 dark:text-neutral-100">
                  <span>テーブル {t + 1}</span>
                  <span className="text-xs font-normal text-neutral-500 dark:text-neutral-400">
                    {row.filter((id) => id !== null).length}/{row.length}人
                  </span>
                </div>
                <ul className="flex flex-col">
                  {row.map((id, s) => {
                    const isSelected = selected?.table === t && selected.seat === s;
                    return (
                      <li key={s} className="border-t border-neutral-200 first:border-t-0 dark:border-neutral-800">
                        <button
                          type="button"
                          data-testid="seating-seat"
                          data-table={t + 1}
                          data-seat={s + 1}
                          aria-pressed={isSelected}
                          aria-label={`テーブル${t + 1} 席${s + 1} ${id === null ? "空席" : (nameById.get(id) ?? "")}`}
                          onClick={() => handleSeatClick({ table: t, seat: s })}
                          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                            isSelected
                              ? "bg-amber-100 dark:bg-amber-900/40"
                              : "hover:bg-neutral-50 dark:hover:bg-neutral-900"
                          } ${id === null ? "text-neutral-400" : "text-neutral-800 dark:text-neutral-100"}`}
                        >
                          <span className="w-5 text-xs text-neutral-400">{s + 1}</span>
                          <span className="truncate">{id === null ? "（空席）" : (nameById.get(id) ?? "")}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
            <h3 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">6. ファイルに保存する</h3>
            <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              タイトル（PDF・ファイル名に使います）
              <input value={title} onChange={(e) => setTitle(e.target.value)} className={`${inputClass} w-full max-w-sm`} />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <RewardedDownloadGate onDownload={() => exportAs("pdf")} label="PDFでダウンロード" disabled={exporting || planErrors.length > 0} />
              <RewardedDownloadGate onDownload={() => exportAs("xlsx")} label="Excelでダウンロード" disabled={exporting || planErrors.length > 0} />
              <RewardedDownloadGate onDownload={() => exportAs("csv")} label="CSVでダウンロード" disabled={exporting || planErrors.length > 0} />
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              PDFはA4横で、印刷しやすいようにテーブルごとの枠にまとめます。ExcelとCSVには、氏名・テーブル・席番号の一覧も入ります。
            </p>
            {exportError && <ErrorMessage message={exportError} />}
          </div>
        </section>
      )}
    </div>
  );
}

function RuleList({
  title,
  hint,
  testId,
  items,
  onChange,
  addLabel,
}: {
  title: string;
  hint: string;
  testId: string;
  items: string[];
  onChange: (next: string[]) => void;
  addLabel: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">{title}</p>
      {items.map((text, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <input
            data-testid={testId}
            aria-label={`${title}の${i + 1}つ目`}
            value={text}
            placeholder={hint}
            onChange={(e) => onChange(items.map((t, k) => (k === i ? e.target.value : t)))}
            className={`${inputClass} min-w-0 flex-1`}
          />
          <button type="button" onClick={() => onChange(items.filter((_, k) => k !== i))} className={smallButton}>
            削除
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...items, ""])} className={`${smallButton} w-fit`}>
        {addLabel}
      </button>
    </div>
  );
}
