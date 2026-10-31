"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  bulkFill,
  checkSchedule,
  clearType,
  colorHex,
  DEFAULT_SETTINGS,
  defaultTypes,
  emptyCells,
  formatDuration,
  monthDays,
  parseSavedSchedule,
  parseStaffNames,
  resizeCells,
  serializeSchedule,
  SHIFT_COLORS,
  SHIFT_MAX_STAFF,
  SHIFT_MAX_TYPES,
  SHIFT_MAX_YEAR,
  SHIFT_MIN_YEAR,
  summarize,
  validateStaff,
  validateTypes,
  validateYearMonth,
  WEEKDAY_LABELS,
  type ShiftSchedule,
  type ShiftType,
} from "@/lib/shift/model";
import { shiftTitle, shiftToCsvBlob, shiftToPdfBlob, shiftToXlsxBlob, typeTimeText } from "@/lib/processors/browser/shift-export";
import { downloadBlob, sanitizeFileName } from "@/lib/utils/format";

const inputClass =
  "rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100";
const smallButton =
  "rounded-lg bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-200 disabled:opacity-40 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700";
const sectionClass = "flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800";
const labelClass = "flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400";

function initialSchedule(): ShiftSchedule {
  const now = new Date();
  const staff = [1, 2, 3, 4].map((n) => ({ id: `s${n}`, name: `スタッフ${n}` }));
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const cells: Record<string, (string | null)[]> = {};
  for (const s of staff) cells[s.id] = emptyCells(days);
  return {
    title: "",
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    types: defaultTypes(),
    staff,
    cells,
    settings: { ...DEFAULT_SETTINGS },
  };
}

function toInt(value: string, fallback: number): number {
  const n = Number(value.normalize("NFKC"));
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

/** シフト表作成。勤務区分とスタッフを決め、日ごとの勤務を入れて、確認し、PDF・Excel・CSVで保存する（自動での割り当てはしない） */
export function ShiftScheduleTool() {
  const [schedule, setSchedule] = useState<ShiftSchedule>(initialSchedule);
  const [brush, setBrush] = useState<string | null>("t1");
  const [staffText, setStaffText] = useState("");
  const [bulk, setBulk] = useState({ staffId: "", weekdays: [] as number[], includeHolidays: false, typeId: "t4", onlyBlank: true });
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const painting = useRef(false);
  const counter = useRef(100);

  useEffect(() => {
    const stop = () => {
      painting.current = false;
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  const days = useMemo(() => monthDays(schedule.year, schedule.month), [schedule.year, schedule.month]);
  const ymError = validateYearMonth(schedule.year, schedule.month);
  const typeProblems = useMemo(() => validateTypes(schedule.types), [schedule.types]);
  const staffProblems = useMemo(() => validateStaff(schedule.staff), [schedule.staff]);
  const typeById = useMemo(() => new Map(schedule.types.map((t) => [t.id, t])), [schedule.types]);
  const summary = useMemo(() => (ymError ? null : summarize(schedule)), [schedule, ymError]);
  const issues = useMemo(() => (ymError || typeProblems.length > 0 ? [] : checkSchedule(schedule)), [schedule, ymError, typeProblems]);
  const flagged = useMemo(() => {
    const set = new Set<string>();
    for (const issue of issues) {
      if ((issue.kind === "consecutive" || issue.kind === "rest") && issue.staffId) for (const d of issue.days) set.add(`${issue.staffId}:${d}`);
    }
    return set;
  }, [issues]);
  const problems = [...(ymError ? [ymError] : []), ...typeProblems, ...staffProblems];

  function newId(prefix: string, used: Set<string>): string {
    let id = "";
    do {
      counter.current += 1;
      id = `${prefix}${counter.current}`;
    } while (used.has(id));
    return id;
  }

  function update(patch: Partial<ShiftSchedule>) {
    setSchedule((s) => ({ ...s, ...patch }));
    setMessage(null);
  }

  function setYearMonth(year: number, month: number) {
    setSchedule((s) => {
      if (validateYearMonth(year, month)) return { ...s, year, month };
      const count = new Date(year, month, 0).getDate();
      const cells: Record<string, (string | null)[]> = {};
      for (const m of s.staff) cells[m.id] = resizeCells(s.cells[m.id], count);
      return { ...s, year, month, cells };
    });
    setMessage(null);
  }

  function paint(staffId: string, dayIndex: number) {
    setSchedule((s) => {
      const row = resizeCells(s.cells[staffId], days.length);
      if (row[dayIndex] === brush) return s;
      const next = [...row];
      next[dayIndex] = brush;
      return { ...s, cells: { ...s.cells, [staffId]: next } };
    });
  }

  function updateType(id: string, patch: Partial<ShiftType>) {
    update({ types: schedule.types.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  }

  function addType() {
    if (schedule.types.length >= SHIFT_MAX_TYPES) return;
    const id = newId("t", new Set(schedule.types.map((t) => t.id)));
    const usedColors = new Set(schedule.types.map((t) => t.color));
    const color = SHIFT_COLORS.find((c) => !usedColors.has(c.id))?.id ?? "gray";
    update({ types: [...schedule.types, { id, code: "", name: "", kind: "work", start: "09:00", end: "18:00", breakMinutes: 60, color }] });
  }

  function removeType(id: string) {
    const { cells } = clearType(schedule.cells, id);
    update({ types: schedule.types.filter((t) => t.id !== id), cells });
    if (brush === id) setBrush(null);
  }

  function addStaff(names: string[]) {
    const room = SHIFT_MAX_STAFF - schedule.staff.length;
    const take = names.slice(0, Math.max(0, room));
    if (take.length === 0) return;
    const used = new Set(schedule.staff.map((s) => s.id));
    const added = take.map((name) => ({ id: newId("s", used), name }));
    for (const a of added) used.add(a.id);
    const cells = { ...schedule.cells };
    for (const a of added) cells[a.id] = emptyCells(days.length);
    update({ staff: [...schedule.staff, ...added], cells });
    if (names.length > take.length) setMessage(`スタッフは${SHIFT_MAX_STAFF}人までです。超えた${names.length - take.length}人は追加していません。`);
  }

  function removeStaff(id: string) {
    const cells = { ...schedule.cells };
    delete cells[id];
    update({ staff: schedule.staff.filter((s) => s.id !== id), cells });
  }

  function moveStaff(index: number, delta: number) {
    const to = index + delta;
    if (to < 0 || to >= schedule.staff.length) return;
    const next = [...schedule.staff];
    [next[index], next[to]] = [next[to], next[index]];
    update({ staff: next });
  }

  function runBulk() {
    if (ymError) return;
    if (bulk.weekdays.length === 0 && !bulk.includeHolidays) {
      setBulkMessage("曜日を1つ以上選ぶか、祝日にチェックを入れてください。");
      return;
    }
    const typeId = bulk.typeId === "" ? null : bulk.typeId;
    const { cells, changed } = bulkFill(schedule, {
      staffIds: bulk.staffId === "" ? [] : [bulk.staffId],
      weekdays: bulk.weekdays,
      includeHolidays: bulk.includeHolidays,
      typeId,
      onlyBlank: bulk.onlyBlank,
    });
    setSchedule((s) => ({ ...s, cells }));
    setBulkMessage(`${changed}個のセルを変更しました。`);
  }

  async function exportAs(kind: "pdf" | "xlsx" | "csv") {
    setExportError(null);
    setExporting(true);
    try {
      const base = sanitizeFileName(shiftTitle(schedule));
      if (kind === "pdf") downloadBlob((await shiftToPdfBlob(schedule)).blob, `${base}.pdf`);
      else if (kind === "xlsx") downloadBlob(await shiftToXlsxBlob(schedule), `${base}.xlsx`);
      else downloadBlob(shiftToCsvBlob(schedule), `${base}.csv`);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "ファイルを作成できませんでした");
    } finally {
      setExporting(false);
    }
  }

  function saveJson() {
    const base = sanitizeFileName(shiftTitle(schedule));
    downloadBlob(new Blob([serializeSchedule(schedule)], { type: "application/json" }), `${base}（保存用）.json`);
  }

  async function loadJson(files: File[]) {
    setLoadError(null);
    const text = await files[0].text();
    const { schedule: loaded, error } = parseSavedSchedule(text);
    if (!loaded) {
      setLoadError(error ?? "ファイルを読み込めませんでした。");
      return;
    }
    setSchedule(loaded);
    setBrush(loaded.types[0]?.id ?? null);
    setBulk((b) => ({ ...b, staffId: "", typeId: loaded.types.find((t) => t.kind === "off")?.id ?? "" }));
    setMessage("保存したファイルを読み込みました。");
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="rounded-xl bg-neutral-50 p-3 text-xs leading-relaxed text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
        勤務区分とスタッフを決めて、日ごとの勤務を表に入れていくツールです。勤務の自動割り当てや最適化はしません。連続勤務や勤務間の休息時間は、下で決めた目安に合わない箇所を知らせるだけで、法令に合っているかは判定しません。入力した内容は、この端末の中だけで処理し、外部には送りません。
      </p>

      <section className={sectionClass} aria-labelledby="shift-step1">
        <h3 id="shift-step1" className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">1. 年月と確認の目安</h3>
        <div className="flex flex-wrap items-end gap-3">
          <label className={labelClass}>
            タイトル（空なら年月から付けます）
            <input data-testid="shift-title" value={schedule.title} maxLength={60} onChange={(e) => update({ title: e.target.value })} className={`${inputClass} w-56`} />
          </label>
          <label className={labelClass}>
            年
            <input
              data-testid="shift-year"
              type="number"
              min={SHIFT_MIN_YEAR}
              max={SHIFT_MAX_YEAR}
              value={schedule.year}
              onChange={(e) => setYearMonth(toInt(e.target.value, schedule.year), schedule.month)}
              className={`${inputClass} w-24`}
            />
          </label>
          <label className={labelClass}>
            月
            <select data-testid="shift-month" value={schedule.month} onChange={(e) => setYearMonth(schedule.year, Number(e.target.value))} className={inputClass}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>{m}月</option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className={labelClass}>
            連続勤務の上限の目安（日。0は確認しない）
            <input
              data-testid="shift-max-consecutive"
              type="number"
              min={0}
              max={31}
              value={schedule.settings.maxConsecutive}
              onChange={(e) => update({ settings: { ...schedule.settings, maxConsecutive: Math.min(31, Math.max(0, toInt(e.target.value, 0))) } })}
              className={`${inputClass} w-24`}
            />
          </label>
          <label className={labelClass}>
            勤務間にあけたい時間（時間。0は確認しない）
            <input
              data-testid="shift-min-rest"
              type="number"
              min={0}
              max={24}
              value={schedule.settings.minRestHours}
              onChange={(e) => update({ settings: { ...schedule.settings, minRestHours: Math.min(24, Math.max(0, toInt(e.target.value, 0))) } })}
              className={`${inputClass} w-24`}
            />
          </label>
          <label className={labelClass}>
            1日に必要な出勤人数（0は確認しない）
            <input
              data-testid="shift-min-staff"
              type="number"
              min={0}
              max={SHIFT_MAX_STAFF}
              value={schedule.settings.minStaffPerDay}
              onChange={(e) => update({ settings: { ...schedule.settings, minStaffPerDay: Math.min(SHIFT_MAX_STAFF, Math.max(0, toInt(e.target.value, 0))) } })}
              className={`${inputClass} w-24`}
            />
          </label>
        </div>
        {ymError && <ErrorMessage message={ymError} />}
      </section>

      <section className={sectionClass} aria-labelledby="shift-step2">
        <h3 id="shift-step2" className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">2. 勤務区分（表に入れる種類）</h3>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          終了時刻が開始時刻以前のときは、翌日の時刻として数えます（夜勤など。例：22:00〜06:00）。「休み」は実働時間に含めません。
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs">
            <thead>
              <tr className="text-left text-neutral-500 dark:text-neutral-400">
                <th className="pb-1 pr-2 font-normal">略称</th>
                <th className="pb-1 pr-2 font-normal">名前</th>
                <th className="pb-1 pr-2 font-normal">種類</th>
                <th className="pb-1 pr-2 font-normal">開始</th>
                <th className="pb-1 pr-2 font-normal">終了</th>
                <th className="pb-1 pr-2 font-normal">休憩(分)</th>
                <th className="pb-1 pr-2 font-normal">色</th>
                <th className="pb-1 font-normal"><span className="sr-only">削除</span></th>
              </tr>
            </thead>
            <tbody>
              {schedule.types.map((t, i) => (
                <tr key={t.id} data-testid={`shift-type-${i}`}>
                  <td className="pr-2 pb-1"><input aria-label={`${i + 1}番目の略称`} data-testid={`shift-type-code-${i}`} value={t.code} onChange={(e) => updateType(t.id, { code: e.target.value })} className={`${inputClass} w-14`} /></td>
                  <td className="pr-2 pb-1"><input aria-label={`${i + 1}番目の名前`} data-testid={`shift-type-name-${i}`} value={t.name} onChange={(e) => updateType(t.id, { name: e.target.value })} className={`${inputClass} w-28`} /></td>
                  <td className="pr-2 pb-1">
                    <select aria-label={`${i + 1}番目の種類`} data-testid={`shift-type-kind-${i}`} value={t.kind} onChange={(e) => updateType(t.id, { kind: e.target.value === "off" ? "off" : "work" })} className={inputClass}>
                      <option value="work">勤務</option>
                      <option value="off">休み</option>
                    </select>
                  </td>
                  <td className="pr-2 pb-1"><input aria-label={`${i + 1}番目の開始時刻`} data-testid={`shift-type-start-${i}`} disabled={t.kind === "off"} value={t.kind === "off" ? "" : t.start} onChange={(e) => updateType(t.id, { start: e.target.value })} className={`${inputClass} w-20 disabled:opacity-40`} placeholder="09:00" /></td>
                  <td className="pr-2 pb-1"><input aria-label={`${i + 1}番目の終了時刻`} data-testid={`shift-type-end-${i}`} disabled={t.kind === "off"} value={t.kind === "off" ? "" : t.end} onChange={(e) => updateType(t.id, { end: e.target.value })} className={`${inputClass} w-20 disabled:opacity-40`} placeholder="18:00" /></td>
                  <td className="pr-2 pb-1"><input aria-label={`${i + 1}番目の休憩`} data-testid={`shift-type-break-${i}`} disabled={t.kind === "off"} type="number" min={0} value={t.kind === "off" ? 0 : t.breakMinutes} onChange={(e) => updateType(t.id, { breakMinutes: Math.max(0, toInt(e.target.value, 0)) })} className={`${inputClass} w-20 disabled:opacity-40`} /></td>
                  <td className="pr-2 pb-1">
                    <select aria-label={`${i + 1}番目の色`} value={t.color} onChange={(e) => updateType(t.id, { color: e.target.value })} className={inputClass} style={{ backgroundColor: colorHex(t.color), color: "#171717" }}>
                      {SHIFT_COLORS.map((c) => (
                        <option key={c.id} value={c.id}>{c.label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="pb-1"><button type="button" className={smallButton} onClick={() => removeType(t.id)} aria-label={`${t.name || t.code || `${i + 1}番目`}を削除`}>削除</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <button type="button" className={smallButton} onClick={addType} disabled={schedule.types.length >= SHIFT_MAX_TYPES} data-testid="shift-add-type">勤務区分を追加（{schedule.types.length}/{SHIFT_MAX_TYPES}）</button>
        </div>
        {typeProblems.length > 0 && (
          <div data-testid="shift-type-errors" className="flex flex-col gap-2">
            {typeProblems.map((p) => (
              <ErrorMessage key={p} message={p} />
            ))}
          </div>
        )}
      </section>

      <section className={sectionClass} aria-labelledby="shift-step3">
        <h3 id="shift-step3" className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">3. スタッフ</h3>
        <ul className="flex flex-col gap-1.5">
          {schedule.staff.map((s, i) => (
            <li key={s.id} className="flex items-center gap-2">
              <span className="w-6 text-right text-xs text-neutral-400">{i + 1}</span>
              <input aria-label={`${i + 1}人目の名前`} data-testid={`shift-staff-name-${i}`} value={s.name} maxLength={60} onChange={(e) => update({ staff: schedule.staff.map((m) => (m.id === s.id ? { ...m, name: e.target.value } : m)) })} className={`${inputClass} w-48`} />
              <button type="button" className={smallButton} onClick={() => moveStaff(i, -1)} disabled={i === 0} aria-label={`${s.name || i + 1}を上へ`}>上へ</button>
              <button type="button" className={smallButton} onClick={() => moveStaff(i, 1)} disabled={i === schedule.staff.length - 1} aria-label={`${s.name || i + 1}を下へ`}>下へ</button>
              <button type="button" className={smallButton} onClick={() => removeStaff(s.id)} aria-label={`${s.name || i + 1}を削除`}>削除</button>
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-2">
          <label className={labelClass}>
            名前をまとめて追加（1行に1人。「、」「,」区切りも可）
            <textarea data-testid="shift-staff-bulk" value={staffText} onChange={(e) => setStaffText(e.target.value)} rows={3} className={`${inputClass} w-full max-w-md`} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={smallButton} data-testid="shift-staff-bulk-add" onClick={() => { addStaff(parseStaffNames(staffText)); setStaffText(""); }} disabled={parseStaffNames(staffText).length === 0}>まとめて追加</button>
            <button type="button" className={smallButton} data-testid="shift-add-staff" onClick={() => addStaff([""])} disabled={schedule.staff.length >= SHIFT_MAX_STAFF}>1人追加（{schedule.staff.length}/{SHIFT_MAX_STAFF}）</button>
          </div>
        </div>
        {staffProblems.length > 0 && (
          <div data-testid="shift-staff-errors" className="flex flex-col gap-2">
            {staffProblems.map((p) => (
              <ErrorMessage key={p} message={p} />
            ))}
          </div>
        )}
      </section>

      <section className={sectionClass} aria-labelledby="shift-step4" data-testid="tool-preview">
        <h3 id="shift-step4" className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">4. 勤務表（{schedule.year}年{schedule.month}月）</h3>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          入れたい勤務区分を選んでから、表のマスを押すか、マウスでなぞってください（キーボードでは、マスに移動してEnterキーかスペースキー）。同じ勤務区分をもう一度入れても、変わりません。
        </p>
        <div role="group" aria-label="入れる勤務区分" className="flex flex-wrap gap-2">
          {schedule.types.map((t) => (
            <button
              key={t.id}
              type="button"
              data-testid={`shift-brush-${t.code.trim() || t.id}`}
              aria-pressed={brush === t.id}
              onClick={() => setBrush(t.id)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium text-neutral-900 ${brush === t.id ? "border-neutral-900 ring-2 ring-neutral-900 dark:border-white dark:ring-white" : "border-neutral-300"}`}
              style={{ backgroundColor: colorHex(t.color) }}
              title={typeTimeText(t)}
            >
              {t.code.trim() || "（略称なし）"} {t.name.trim()}
            </button>
          ))}
          <button type="button" data-testid="shift-brush-clear" aria-pressed={brush === null} onClick={() => setBrush(null)} className={`rounded-lg border px-3 py-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-200 ${brush === null ? "border-neutral-900 ring-2 ring-neutral-900 dark:border-white dark:ring-white" : "border-neutral-300 dark:border-neutral-700"}`}>
            消す（空欄）
          </button>
        </div>

        {schedule.staff.length > 0 && !ymError && (
          <div className="overflow-x-auto" onPointerLeave={() => { painting.current = false; }}>
            <table className="border-collapse text-xs" data-testid="shift-grid" style={{ userSelect: "none" }}>
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 min-w-[7rem] border border-neutral-300 bg-neutral-100 px-2 py-1 text-left font-medium dark:border-neutral-700 dark:bg-neutral-800">氏名</th>
                  {days.map((d) => {
                    const off = d.holiday !== null || d.weekday === 0;
                    const bg = off ? "bg-red-100 dark:bg-red-950" : d.weekday === 6 ? "bg-blue-100 dark:bg-blue-950" : "bg-neutral-100 dark:bg-neutral-800";
                    return (
                      <th key={d.day} title={d.holiday ?? undefined} className={`min-w-[2rem] border border-neutral-300 px-0.5 py-1 text-center font-medium dark:border-neutral-700 ${bg}`}>
                        <div>{d.day}</div>
                        <div>{d.weekdayLabel}</div>
                      </th>
                    );
                  })}
                  {["出勤", "休日", "未入力", "実働"].map((h) => (
                    <th key={h} className="border border-neutral-300 bg-neutral-100 px-1.5 py-1 text-center font-medium dark:border-neutral-700 dark:bg-neutral-800">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {schedule.staff.map((s, si) => {
                  const row = resizeCells(schedule.cells[s.id], days.length);
                  const sum = summary?.perStaff[si];
                  return (
                    <tr key={s.id} data-testid={`shift-row-${si}`}>
                      <th scope="row" className="sticky left-0 z-10 max-w-[10rem] truncate border border-neutral-300 bg-white px-2 py-1 text-left font-normal dark:border-neutral-700 dark:bg-neutral-950">{s.name.trim() || "（名前なし）"}</th>
                      {row.map((id, di) => {
                        const type = id === null ? undefined : typeById.get(id);
                        const bad = flagged.has(`${s.id}:${di + 1}`);
                        return (
                          <td key={di} className="border border-neutral-300 p-0 dark:border-neutral-700">
                            <button
                              type="button"
                              data-testid={`shift-cell-${si}-${di + 1}`}
                              data-code={type?.code.trim() ?? ""}
                              data-flagged={bad ? "true" : undefined}
                              aria-label={`${s.name.trim() || "名前なし"} ${schedule.month}月${di + 1}日 ${type ? `${type.name.trim()}` : "未入力"}${bad ? "（要確認）" : ""}`}
                              onPointerDown={(e) => {
                                if (e.button !== 0) return;
                                painting.current = true;
                                paint(s.id, di);
                              }}
                              onPointerEnter={() => {
                                if (painting.current) paint(s.id, di);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  paint(s.id, di);
                                }
                              }}
                              className={`flex h-8 w-8 items-center justify-center text-xs text-neutral-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 ${bad ? "outline outline-2 -outline-offset-2 outline-red-600" : ""}`}
                              style={{ backgroundColor: type ? colorHex(type.color) : undefined, color: type ? undefined : "inherit" }}
                            >
                              {type?.code.trim() ?? ""}
                            </button>
                          </td>
                        );
                      })}
                      <td className="border border-neutral-300 px-1.5 text-center dark:border-neutral-700" data-testid={`shift-sum-work-${si}`}>{sum?.workDays}</td>
                      <td className="border border-neutral-300 px-1.5 text-center dark:border-neutral-700" data-testid={`shift-sum-off-${si}`}>{sum?.offDays}</td>
                      <td className="border border-neutral-300 px-1.5 text-center dark:border-neutral-700" data-testid={`shift-sum-blank-${si}`}>{sum?.blankDays}</td>
                      <td className="border border-neutral-300 px-1.5 text-center dark:border-neutral-700" data-testid={`shift-sum-time-${si}`}>{sum ? formatDuration(sum.workMinutes) : ""}</td>
                    </tr>
                  );
                })}
                <tr>
                  <th scope="row" className="sticky left-0 z-10 border border-neutral-300 bg-neutral-100 px-2 py-1 text-left font-medium dark:border-neutral-700 dark:bg-neutral-800">出勤人数</th>
                  {summary?.perDay.map((d, i) => (
                    <td key={i} data-testid={`shift-day-count-${i + 1}`} className="border border-neutral-300 bg-neutral-50 text-center dark:border-neutral-700 dark:bg-neutral-900">{d.working}</td>
                  ))}
                  <td colSpan={4} className="border border-neutral-300 dark:border-neutral-700" />
                </tr>
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-col gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <h4 className="text-xs font-semibold text-neutral-700 dark:text-neutral-200">曜日を指定して、まとめて入れる</h4>
          <div className="flex flex-wrap items-end gap-3">
            <label className={labelClass}>
              対象
              <select data-testid="shift-bulk-staff" value={bulk.staffId} onChange={(e) => setBulk({ ...bulk, staffId: e.target.value })} className={inputClass}>
                <option value="">全員</option>
                {schedule.staff.map((s, i) => (
                  <option key={s.id} value={s.id}>{s.name.trim() || `${i + 1}人目`}</option>
                ))}
              </select>
            </label>
            <fieldset className="flex flex-wrap items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
              <legend className="sr-only">対象の曜日</legend>
              {WEEKDAY_LABELS.map((w, i) => (
                <label key={w} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    data-testid={`shift-bulk-weekday-${i}`}
                    checked={bulk.weekdays.includes(i)}
                    onChange={(e) => setBulk({ ...bulk, weekdays: e.target.checked ? [...bulk.weekdays, i] : bulk.weekdays.filter((x) => x !== i) })}
                  />
                  {w}
                </label>
              ))}
              <label className="flex items-center gap-1">
                <input type="checkbox" data-testid="shift-bulk-holiday" checked={bulk.includeHolidays} onChange={(e) => setBulk({ ...bulk, includeHolidays: e.target.checked })} />
                祝日
              </label>
            </fieldset>
            <label className={labelClass}>
              入れるもの
              <select data-testid="shift-bulk-type" value={bulk.typeId} onChange={(e) => setBulk({ ...bulk, typeId: e.target.value })} className={inputClass}>
                <option value="">（空欄にする）</option>
                {schedule.types.map((t) => (
                  <option key={t.id} value={t.id}>{t.code.trim()} {t.name.trim()}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-xs text-neutral-600 dark:text-neutral-300">
              <input type="checkbox" data-testid="shift-bulk-only-blank" checked={bulk.onlyBlank} onChange={(e) => setBulk({ ...bulk, onlyBlank: e.target.checked })} />
              すでに入っているマスは変えない
            </label>
            <button type="button" className={smallButton} data-testid="shift-bulk-run" onClick={runBulk}>まとめて入れる</button>
          </div>
          {bulkMessage && <p data-testid="shift-bulk-message" className="text-xs text-neutral-600 dark:text-neutral-300">{bulkMessage}</p>}
        </div>

        <div className="flex flex-col gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800" data-testid="shift-issues">
          <h4 className="text-xs font-semibold text-neutral-700 dark:text-neutral-200">確認（決めた目安に合わない箇所）</h4>
          {typeProblems.length > 0 ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">勤務区分に入力の不備があるため、確認は行っていません。上の「2. 勤務区分」を直してください。</p>
          ) : issues.length === 0 ? (
            <p data-testid="shift-issues-none" className="text-xs text-neutral-600 dark:text-neutral-300">目安に合わない箇所は見つかりませんでした。</p>
          ) : (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-neutral-700 dark:text-neutral-200">
              {issues.map((issue, i) => (
                <li key={i} data-kind={issue.kind}>{issue.message}</li>
              ))}
            </ul>
          )}
          <p className="text-xs text-neutral-500 dark:text-neutral-400">これは入力した目安との比較だけで、労働基準法などの法令や、就業規則に合っているかの判定ではありません。</p>
        </div>
      </section>

      <section className={sectionClass} aria-labelledby="shift-step5">
        <h3 id="shift-step5" className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">5. 保存と書き出し</h3>
        {problems.length > 0 && <ErrorMessage message={`入力に不備があるため、書き出せません：${problems[0]}${problems.length > 1 ? `（ほか${problems.length - 1}件）` : ""}`} testId="shift-export-blocked" />}
        <div className="flex flex-wrap items-center gap-3">
          <RewardedDownloadGate onDownload={() => exportAs("pdf")} label="PDFでダウンロード" disabled={exporting || problems.length > 0} />
          <RewardedDownloadGate onDownload={() => exportAs("xlsx")} label="Excelでダウンロード" disabled={exporting || problems.length > 0} />
          <RewardedDownloadGate onDownload={() => exportAs("csv")} label="CSVでダウンロード" disabled={exporting || problems.length > 0} />
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          PDFはA4横です（30人を超えると、ページを分けます）。ExcelとPDFには、色つきの表、出勤日数・休日数・未入力・実働時間、日ごとの出勤人数が入ります。未入力のマスは空欄で出力します。
        </p>
        {exportError && <ErrorMessage message={exportError} />}
        <div className="flex flex-col gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <h4 className="text-xs font-semibold text-neutral-700 dark:text-neutral-200">続きを後で作る（保存ファイル）</h4>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">このページを閉じると、入力した内容は消えます。続きを作るときは、保存ファイルを作っておき、次回に読み込んでください。</p>
          <div>
            <button type="button" className={smallButton} data-testid="shift-save-json" onClick={saveJson}>保存ファイル（JSON）を作る</button>
          </div>
          <FileDropzone accept=".json" maxSizeMB={5} label="保存ファイル（JSON）を読み込む" hint="このツールで作った保存ファイルを選んでください" onFilesSelected={loadJson} onError={setLoadError} />
          {loadError && <ErrorMessage message={loadError} testId="shift-load-error" />}
        </div>
        {message && <p data-testid="shift-message" className="text-xs text-neutral-600 dark:text-neutral-300">{message}</p>}
      </section>
    </div>
  );
}
