"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ErrorMessage } from "@/components/common/error-message";
import { usePageFileDrop } from "@/components/common/page-file-drop";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  autoParams,
  buildLayout,
  DEFAULT_PARAMS,
  LIMITS,
  MAX_SEATS,
  normalizeParams,
  PURPOSES,
  rotateLayout,
  SEAT_H,
  SEAT_START_OPTIONS,
  SEAT_W,
  type SeatStart,
  type LayoutParams,
  type Purpose,
} from "@/lib/seating/layouts";
import { cleanReading, namesFromRows, parseParticipants, readingsFromPaste, SEATING_MAX_PARTICIPANTS, type Participant } from "@/lib/seating/participants";
import { axisGroups, canShuffle, evictBlocked, fillAroundLocked } from "@/lib/seating/arrange";
import { describeRule, isActiveRule, shuffleWithRules, violatedRules, type SeatGrid, type SeatRule } from "@/lib/seating/conditions";
import { exportChart, PAPER_SIZES, type ExportFormat, type PaperOrientation, type PaperSize, type SeatingChartModel } from "@/lib/processors/browser/seating-export";
import { classifyMergeFile, loadMergeFile, MERGE_LEGACY_EXCEL_MESSAGE, MERGE_UNSUPPORTED_MESSAGE } from "@/lib/processors/browser/excel-merge";
import { downloadBlob, sanitizeFileName } from "@/lib/utils/format";

/** 人数に合わせて自動で変わる項目（手で変えると「人数に合わせる」を外す） */
const AUTO_FIELDS: Record<Purpose, (keyof LayoutParams)[]> = {
  meeting: ["perSide", "head"],
  "meeting-u": ["front", "sides"],
  group: ["tables"],
  round: ["tables"],
  classroom: ["rows"],
  custom: ["rows"],
};

const DEFAULTS_BY_PURPOSE: Record<Purpose, Partial<LayoutParams>> = {
  meeting: {},
  "meeting-u": {},
  group: { perTable: 6 },
  round: { perTable: 8 },
  classroom: { cols: 6 },
  custom: { cols: 6, rows: 4 },
};

const TITLE_BY_PURPOSE: Record<Purpose, string> = {
  meeting: "会議 座席表",
  "meeting-u": "会議 座席表",
  group: "グループワーク 座席表",
  classroom: "座席表",
  round: "懇親会 座席表",
  custom: "座席表",
};

const FORMATS: { value: ExportFormat; label: string; ext: string }[] = [
  { value: "png", label: "画像（PNG）", ext: "png" },
  { value: "jpeg", label: "画像（JPEG）", ext: "jpg" },
  { value: "pdf", label: "PDF", ext: "pdf" },
];

/** 札の候補（自由に書くこともできる） */
const TAG_PRESETS = ["来賓", "主賓", "司会", "議長", "書記", "講師", "受付", "幹事", "予備"];

const PURPOSE_ICON: Record<Purpose, string> = {
  meeting: "M3 10h18v4H3z M5 6h3v3H5z M10.5 6h3v3h-3z M16 6h3v3h-3z M5 15h3v3H5z M10.5 15h3v3h-3z M16 15h3v3h-3z",
  "meeting-u": "M5 5h14v3H5z M5 8h3v11H5z M16 8h3v11h-3z",
  group: "M3 4h7v5H3z M14 4h7v5h-7z M3 14h7v5H3z M14 14h7v5h-7z",
  classroom: "M8 3h8v2H8z M3 8h4v3H3z M10 8h4v3h-4z M17 8h4v3h-4z M3 14h4v3H3z M10 14h4v3h-4z M17 14h4v3h-4z",
  round: "M12 6a6 6 0 1 0 0.01 0z",
  custom: "M4 4h4v4H4z M10 4h4v4h-4z M4 10h4v4H4z M16 10h4v4h-4z M10 16h4v4h-4z M16 16h4v4h-4z",
};

const inputClass = "w-20 rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100";
const smallButton =
  "ms-focus-ring rounded-lg bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-200 disabled:opacity-40 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700";
const sectionClass = "flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800";


/**
 * 手で入れ替えたあとに、名簿や席の数が変わったとき：同じ名前の人は同じ席に残し、
 * 席が無くなった人・新しく入った人は、入力順に空いている席へ入れる
 */
function reconcile(prevSlots: (number | null)[], prevNames: string[], participants: Participant[], seats: number): (number | null)[] {
  const byName = new Map(participants.map((p) => [p.name, p.id]));
  const slots: (number | null)[] = Array(seats).fill(null);
  const placed = new Set<number>();
  prevSlots.forEach((pid, i) => {
    if (pid === null || i >= seats) return;
    const id = byName.get(prevNames[pid]);
    if (id !== undefined && !placed.has(id)) {
      slots[i] = id;
      placed.add(id);
    }
  });
  let next = 0;
  for (const p of participants) {
    if (placed.has(p.id)) continue;
    while (next < seats && slots[next] !== null) next++;
    if (next >= seats) break;
    slots[next] = p.id;
    placed.add(p.id);
  }
  return slots;
}

interface Manual {
  slots: (number | null)[];
  names: string[];
}

export function SeatingChartTool() {
  const [purpose, setPurpose] = useState<Purpose | null>(null);
  const [baseParams, setBaseParams] = useState<Record<Purpose, LayoutParams>>(() => {
    const out = {} as Record<Purpose, LayoutParams>;
    for (const p of PURPOSES) out[p.id] = { ...DEFAULT_PARAMS, ...DEFAULTS_BY_PURPOSE[p.id] };
    return out;
  });
  const [autoFit, setAutoFit] = useState<Record<Purpose, boolean>>({ meeting: true, "meeting-u": true, group: true, round: true, classroom: true, custom: true });
  const [namesText, setNamesText] = useState("");
  const [title, setTitle] = useState("");
  const [manual, setManual] = useState<Manual | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [tags, setTags] = useState<Record<number, string>>({});
  const [paper, setPaper] = useState<PaperSize>("A4");
  const [paperOrientation, setPaperOrientation] = useState<PaperOrientation>("auto");
  /** 前が上の向きと、上下を逆にした向きを、1枚に並べて書き出す */
  const [bothViews, setBothViews] = useState(false);
  const [format, setFormat] = useState<ExportFormat>("png");
  const [exportError, setExportError] = useState<string | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  /** ふりがな（名前ごと。名簿を書き直しても、同じ名前ならそのまま残る） */
  const [readings, setReadings] = useState<Record<string, string>>({});
  const [furigana, setFurigana] = useState(false);
  /** 出席番号を付けるか（null のときは、名簿に番号が書かれていれば付ける） */
  const [showNumbers, setShowNumbers] = useState<boolean | null>(null);
  /** 鍵をかけた席の番号 */
  const [locked, setLocked] = useState<number[]>([]);
  /** 空席にした席の番号（だれも座らせない席。入力順・シャッフルでも人が入らない） */
  const [blocked, setBlocked] = useState<number[]>([]);
  /** 席の条件（離す・近くにする・列を決める・今の列のまま）。プレビュー・書き出しには出さない */
  const [rules, setRules] = useState<SeatRule[]>([]);
  /** 条件を満たす並びが見つからなかったときの案内（条件の欄の中にだけ出す） */
  const [ruleError, setRuleError] = useState<string | null>(null);
  /** プレビューに、鍵・列の固定の印を出すか（生徒に見せるときに分からないよう、最初は出さない） */
  const [showMarks, setShowMarks] = useState(false);
  /** プレビューを画面いっぱいに大きく表示しているか */
  const [fullscreen, setFullscreen] = useState(false);
  /** 座席表の向きを逆にする（前を下にする。先生・司会から見た向き）。画面・印刷・ダウンロードに反映する */
  const [flipped, setFlipped] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const parsed = useMemo(() => parseParticipants(namesText), [namesText]);
  const participants = parsed.participants;
  const names = participants.map((p) => p.name);
  const missingReadings = furigana ? participants.filter((p) => !(readings[p.name] ?? "").trim()).length : 0;

  const params = useMemo(() => {
    if (!purpose) return null;
    const base = baseParams[purpose];
    return normalizeParams(autoFit[purpose] ? autoParams(purpose, participants.length + blocked.length, base) : base);
  }, [purpose, baseParams, autoFit, participants.length, blocked.length]);

  const geometry = useMemo(() => (purpose && params ? buildLayout(purpose, params) : null), [purpose, params]);
  const seatCount = geometry ? Math.min(geometry.seats.length, MAX_SEATS) : 0;

  const blockedKey = blocked.join(",");
  const blockedSet = useMemo(() => new Set(blockedKey === "" ? [] : blockedKey.split(",").map(Number).filter((i) => i < seatCount)), [blockedKey, seatCount]);

  const slots = useMemo(() => {
    let raw: (number | null)[];
    if (!manual) {
      // 入力順に前から入れる（空席にした席は飛ばす）
      raw = fillAroundLocked(Array<number | null>(seatCount).fill(null), blockedSet, participants.length);
    } else {
      const sameNames = manual.names.length === names.length && manual.names.every((n, i) => n === names[i]);
      raw = sameNames && manual.slots.length === seatCount ? manual.slots : reconcile(manual.slots, manual.names, participants, seatCount);
    }
    return evictBlocked(raw, blockedSet);
  }, [manual, participants, names, seatCount, blockedSet]);

  const lockedSet = new Set(locked.filter((i) => i < seatCount));
  /** シャッフル・入力順に戻すで動かさない席（鍵の席と、空席にした席） */
  const fixedSet = new Set([...lockedSet, ...blockedSet]);
  // 出席番号：名簿に書かれた番号を使い、無い人は名簿の順番（1から）
  const numbersOn = showNumbers ?? parsed.hasNumbers;
  const withReading = (p: Participant): Participant => ({
    ...p,
    reading: furigana ? (readings[p.name] ?? "").trim() : "",
    number: p.number ?? String(p.id + 1),
  });

  const seatedIds = new Set(slots.filter((s): s is number => s !== null));
  const unseated = participants.filter((p) => !seatedIds.has(p.id));

  const model: SeatingChartModel | null = geometry
    ? {
        title: title.trim() || (purpose ? TITLE_BY_PURPOSE[purpose] : "座席表"),
        geometry: (() => {
          const g = { ...geometry, seats: geometry.seats.slice(0, seatCount) };
          return flipped ? rotateLayout(g) : g;
        })(),
        assignment: slots.map((id) => (id === null ? null : withReading(participants[id]))),
        unseated: unseated.map(withReading),
        tags: Array.from({ length: seatCount }, (_, i) => tags[i] ?? ""),
        furigana,
        numbers: numbersOn,
        blocked: Array.from({ length: seatCount }, (_, i) => blockedSet.has(i)),
      }
    : null;

  function choosePurpose(p: Purpose) {
    setPurpose(p);
    setManual(null);
    setSelected([]);
    setTags({});
    setLocked([]);
    setBlocked([]);
  }

  function updateParam<K extends keyof LayoutParams>(key: K, value: LayoutParams[K]) {
    if (!purpose || !params) return;
    setBaseParams((prev) => ({ ...prev, [purpose]: { ...params, [key]: value } }));
    if (AUTO_FIELDS[purpose].includes(key)) setAutoFit((prev) => ({ ...prev, [purpose]: false }));
    setSelected([]);
  }

  function swap(a: number, b: number) {
    if (a === b || fixedSet.has(a) || fixedSet.has(b)) return;
    const next = slots.slice();
    [next[a], next[b]] = [next[b], next[a]];
    setManual({ slots: next, names });
    setSelected([]);
  }

  // 席ごとの縦の列・横の列（位置が近い席を同じ列とみなす）
  const colOf = geometry ? axisGroups(geometry.seats.slice(0, seatCount).map((st) => st.x), SEAT_W / 2) : [];
  const rowOf = geometry ? axisGroups(geometry.seats.slice(0, seatCount).map((st) => st.y), SEAT_H / 2) : [];
  const grid: SeatGrid = { col: colOf, row: rowOf };
  const nameSet = new Set(names);
  const activeRules = rules.filter((r) => isActiveRule(r, nameSet));
  const nameOf = (id: number) => participants[id]?.name ?? "";
  /** 今の並びで満たしていない条件 */
  const unmet = violatedRules(activeRules, slots, nameOf, grid);

  /** 選んだ席（鍵・空席を除く）の中だけで、人を並べ替える。席の条件も守る。選択は外さない */
  function shuffleSelected() {
    const chosen = new Set(selected.filter((i) => !fixedSet.has(i)));
    if (chosen.size < 2) return;
    const others = new Set(slots.map((_, i) => i).filter((i) => !chosen.has(i)));
    const result = shuffleWithRules(slots, others, activeRules, nameOf, grid);
    if (result.ok) {
      setManual({ slots: result.slots, names });
      setRuleError(null);
    } else {
      setRuleError("選んだ席の中では、席の条件をすべて満たす並びが見つかりませんでした（並びは変えていません）。");
    }
    // 選んだ席はそのまま残す（同じ席の中で、続けて何度でもシャッフルできる）
  }

  function shuffle() {
    const result = shuffleWithRules(slots, fixedSet, activeRules, nameOf, grid);
    if (result.ok) {
      setManual({ slots: result.slots, names });
      setRuleError(null);
    } else {
      setRuleError("席の条件をすべて満たす並びが見つかりませんでした。条件を減らすか、離す席の数を少なくしてください（並びは変えていません）。");
    }
    setSelected([]);
  }

  /** 入力順に戻す（鍵をかけた席はそのまま） */
  function resetOrder() {
    setManual(lockedSet.size > 0 ? { slots: fillAroundLocked(slots, fixedSet, participants.length), names } : null);
    setSelected([]);
  }

  /** 選んだ席の鍵：すべてかかっていれば外し、そうでなければかける */
  function toggleLock() {
    const allLocked = selected.length > 0 && selected.every((i) => lockedSet.has(i));
    setLocked((prev) => {
      const set = new Set(prev.filter((i) => i < seatCount));
      for (const i of selected) {
        if (allLocked) set.delete(i);
        else set.add(i);
      }
      return [...set].sort((a, b) => a - b);
    });
    // 鍵をかけた時点の席を、そのまま残す
    if (!allLocked && !manual) setManual({ slots, names });
    setSelected([]);
  }

  /** 選んだ席を空席にする（座っていた人は次の空いている席へ移る）。すべて空席なら元に戻す */
  function toggleBlocked() {
    const allBlocked = selected.length > 0 && selected.every((i) => blockedSet.has(i));
    const nextSet = new Set(blockedSet);
    for (const i of selected) {
      if (allBlocked) nextSet.delete(i);
      else nextSet.add(i);
    }
    setBlocked([...nextSet].sort((a, b) => a - b));
    if (!allBlocked) {
      // 空席にした席の鍵は外す。今の並びを残したまま、空席にした席の人だけを移す
      setLocked((prev) => prev.filter((i) => !nextSet.has(i)));
      if (manual || lockedSet.size > 0) setManual({ slots: evictBlocked(slots, nextSet), names });
    }
    setSelected([]);
  }

  function setReading(name: string, value: string) {
    setReadings((prev) => ({ ...prev, [name]: value }));
  }

  function toggleSelect(i: number) {
    // 何席でも選べる（2席なら入れ替え、3席以上なら選んだ席の中でシャッフル）
    setSelected((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]));
  }

  async function importFile(file: File) {
    setImportError(null);
    setImportNote(null);
    const kind = classifyMergeFile(file);
    if (kind === "legacy-excel") return setImportError(MERGE_LEGACY_EXCEL_MESSAGE);
    if (kind === "unsupported") return setImportError(MERGE_UNSUPPORTED_MESSAGE);
    try {
      const loaded = await loadMergeFile(file);
      const sheet = loaded.sheets.find((s) => s.rows.some((r) => r.some((c) => c !== null && String(c).trim() !== ""))) ?? loaded.sheets[0];
      const result = namesFromRows(sheet?.rows ?? []);
      if (result.count === 0) return setImportError("名前を読み取れませんでした。1列目か「氏名」「名前」の列に、名前を入れてください。");
      setNamesText(result.text);
      setManual(null);
      setLocked([]);
      let note = `${result.count}人を読み込みました`;
      if (result.readings) {
        // ふりがなの列：名簿と同じ順番で割り当てる（同じ名前に番号を付けた後の名前で覚える）
        const list = parseParticipants(result.text).participants;
        const found: Record<string, string> = {};
        list.forEach((p, i) => {
          const r = result.readings![i] ?? "";
          if (r) found[p.name] = r;
        });
        const filled = Object.keys(found).length;
        setReadings((prev) => ({ ...prev, ...found }));
        if (filled > 0) {
          setFurigana(true);
          note += `（ふりがなも${filled}人分を読み込みました）`;
        }
      }
      setImportNote(note);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : "読み込めませんでした");
    }
  }

  async function download() {
    if (!model) return;
    setExportError(null);
    try {
      const blob = await exportChart(model, format, { paper, orientation: paperOrientation, bothViews });
      const ext = FORMATS.find((f) => f.value === format)!.ext;
      downloadBlob(blob, `${sanitizeFileName(model.title)}.${ext}`);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "書き出せませんでした");
    }
  }

  // ページ全体へのドロップ：Excel・CSVの名簿を、ページ（大きく表示している画面も含む）のどこに落としても読み込む
  const pageDropOverlay = usePageFileDrop({
    enabled: purpose !== null,
    onFiles: (files) => {
      if (files.length > 0) void importFile(files[0]);
    },
    onReject: setImportError,
    hint: "名簿（Excel・CSV）",
  });

  /** 選んだ席に札を付ける（空なら外す） */
  function tagSelected(text: string) {
    setTags((prev) => {
      const next = { ...prev };
      for (const i of selected) {
        if (text.trim()) next[i] = text.trim().slice(0, 10);
        else delete next[i];
      }
      return next;
    });
    setSelected([]);
  }

  const numberField = (label: string, key: "perSide" | "front" | "sides" | "tables" | "perTable" | "rows" | "cols", testId: string) =>
    params && (
      <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
        {label}
        <input
          type="number"
          inputMode="numeric"
          min={LIMITS[key][0]}
          max={LIMITS[key][1]}
          value={params[key]}
          onChange={(e) => updateParam(key, Number(e.target.value))}
          className={inputClass}
          data-testid={testId}
        />
      </label>
    );

  const step1 = (
      <section className={sectionClass} aria-labelledby="seat-step1">
        <h2 id="seat-step1" className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
          1. 用途を選ぶ
        </h2>
        <div role="radiogroup" aria-label="用途" className={`grid grid-cols-2 gap-2 sm:grid-cols-3 ${purpose ? "lg:grid-cols-2" : ""}`}>
          {PURPOSES.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={purpose === p.id}
              onClick={() => choosePurpose(p.id)}
              data-testid={`seat-purpose-${p.id}`}
              className={`ms-focus-ring flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${purpose ? "lg:gap-1.5 lg:p-2" : ""} ${
                purpose === p.id ? "border-blue-500 bg-blue-50 ring-1 ring-blue-500 dark:bg-blue-950/40" : "border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
              }`}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" className={`h-8 w-8 shrink-0 text-blue-600 dark:text-blue-400 ${purpose ? "lg:h-5 lg:w-5" : ""}`}>
                <path d={PURPOSE_ICON[p.id]} fill="currentColor" fillRule="evenodd" />
              </svg>
              <span className="flex flex-col">
                <span className={`text-sm font-semibold text-neutral-900 dark:text-neutral-100 ${purpose ? "lg:text-xs" : ""}`}>{p.name}</span>
                <span className={`text-xs text-neutral-500 dark:text-neutral-400 ${purpose ? "lg:hidden" : ""}`}>{p.short}</span>
              </span>
            </button>
          ))}
        </div>

        {purpose && params && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-neutral-100 pt-3 dark:border-neutral-800" data-testid="seat-settings">
            {purpose === "meeting" && (
              <>
                {numberField("片側の席", "perSide", "seat-per-side")}
                <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
                  <input type="checkbox" checked={params.head} onChange={(e) => updateParam("head", e.target.checked)} data-testid="seat-head" />
                  議長席
                </label>
              </>
            )}
            {purpose === "meeting-u" && (
              <>
                {numberField("正面の席", "front", "seat-front")}
                {numberField("左右の席", "sides", "seat-sides")}
              </>
            )}
            {(purpose === "group" || purpose === "round") && (
              <>
                {numberField(purpose === "group" ? "島の数" : "テーブルの数", "tables", "seat-tables")}
                {numberField(purpose === "group" ? "1島の席" : "1卓の席", "perTable", "seat-per-table")}
              </>
            )}
            {purpose === "group" && (
              <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
                入れ方
                <select value={params.deal ? "deal" : "fill"} onChange={(e) => updateParam("deal", e.target.value === "deal")} className={`${inputClass} w-auto`} data-testid="seat-deal">
                  <option value="fill">島ごとに詰める</option>
                  <option value="deal">1人ずつ順に配る</option>
                </select>
              </label>
            )}
            {(purpose === "classroom" || purpose === "custom") && (
              <>
                {numberField("横の席", "cols", "seat-cols")}
                {numberField("前からの列", "rows", "seat-rows")}
              </>
            )}
            {purpose === "classroom" && (
              <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
                入れ方
                <select value={params.byColumn ? "col" : "row"} onChange={(e) => updateParam("byColumn", e.target.value === "col")} className={`${inputClass} w-auto`} data-testid="seat-by-column">
                  <option value="row">横に順番</option>
                  <option value="col">縦に順番</option>
                </select>
              </label>
            )}
            {(purpose === "classroom" || purpose === "custom") && (
              <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200" title="席番号1（名前を入れ始める席）の場所。前を上にした図で見た位置です">
                1番の席
                <select value={params.start ?? "front-left"} onChange={(e) => updateParam("start", e.target.value as SeatStart)} className={`${inputClass} w-auto`} data-testid="seat-start">
                  {SEAT_START_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
              <input
                type="checkbox"
                checked={autoFit[purpose]}
                onChange={(e) => setAutoFit((prev) => ({ ...prev, [purpose]: e.target.checked }))}
                data-testid="seat-autofit"
              />
              人数に合わせる
            </label>
            {purpose === "custom" && (
              <div className="w-full">
                <p className="mb-1 text-xs text-neutral-500 dark:text-neutral-400">マスを押すと、席と通路が切り替わります</p>
                <div className="inline-grid gap-1" style={{ gridTemplateColumns: `repeat(${params.cols}, 1.5rem)` }} data-testid="seat-custom-grid">
                  {Array.from({ length: params.rows * params.cols }, (_, k) => {
                    const r = Math.floor(k / params.cols);
                    const c = k % params.cols;
                    const key = `${r}-${c}`;
                    const hole = params.holes.includes(key);
                    return (
                      <button
                        key={key}
                        type="button"
                        aria-pressed={!hole}
                        aria-label={`前から${r + 1}列目・左から${c + 1}番目を${hole ? "席にする" : "通路にする"}`}
                        onClick={() => updateParam("holes", hole ? params.holes.filter((h) => h !== key) : [...params.holes, key])}
                        className={`ms-focus-ring h-6 w-6 rounded ${hole ? "border border-dashed border-neutral-300 dark:border-neutral-700" : "bg-blue-500"}`}
                        data-testid="seat-custom-cell"
                      />
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </section>
  );

  return (
    // スマホ：画面の下に固定したプレビューの裏に、入力欄が隠れないよう、移動するときは下に余白をとる
    <div className="flex flex-col gap-5 max-lg:[&_:is(button,input,select,textarea,a)]:scroll-mb-[45vh]">
      {pageDropOverlay}
      {!purpose && step1}
      {purpose && (
        // PC：真ん中にプレビュー、右にメニュー。スマホ：メニュー → 下に固定したプレビュー（これまでどおり）
        <div data-preview-split className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
          <div className="contents lg:order-2 lg:flex lg:min-w-0 lg:flex-col lg:gap-4" data-testid="seat-menu">

      {step1}

      {purpose && (
        <section className={sectionClass} aria-labelledby="seat-step2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="seat-step2" className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
              2. 名前を入れる
            </h2>
            <div className="flex items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xlsm,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                data-testid="seat-import-input"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void importFile(f);
                }}
              />
              <button type="button" className={smallButton} onClick={() => fileRef.current?.click()} data-testid="seat-import">
                Excel・CSVから読み込む
              </button>
            </div>
          </div>
          <textarea
            value={namesText}
            onChange={(e) => setNamesText(e.target.value)}
            rows={6}
            aria-label="名前と役職（1行に1人。役職は「,」のあと）"
            placeholder={"山田 太郎, 部長\n佐藤 花子, 課長\n鈴木 一郎"}
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            data-testid="seat-names"
          />
          <p className="text-xs text-neutral-500 dark:text-neutral-400" data-testid="seat-count">
            {participants.length}人 ／ {seatCount}席
            {blockedSet.size > 0 && `（うち空席にした席 ${blockedSet.size}）`}
            {parsed.overLimit > 0 && `（${SEATING_MAX_PARTICIPANTS}人まで。${parsed.overLimit}人は読み込んでいません）`}
          </p>
          {importNote && <p className="text-xs text-emerald-700 dark:text-emerald-300">{importNote}</p>}
          {importError && <ErrorMessage message={importError} />}
          {unseated.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-100" data-testid="seat-shortage">
              席が{unseated.length}席足りません（{unseated.slice(0, 5).map((p) => p.name).join("、")}
              {unseated.length > 5 ? " など" : ""}）
              <button type="button" className={smallButton} onClick={() => setAutoFit((prev) => ({ ...prev, [purpose]: true }))}>
                人数に合わせる
              </button>
            </div>
          )}
          <div className="flex flex-col gap-0.5">
            <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
              <input type="checkbox" checked={numbersOn} onChange={(e) => setShowNumbers(e.target.checked)} data-testid="seat-numbers" />
              出席番号を付ける
            </label>
            <p className="pl-6 text-xs text-neutral-500 dark:text-neutral-400">「12 山田太郎」のように行の先頭に書いた番号を使います（無い人は名簿の順）</p>
          </div>
          <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
            <input type="checkbox" checked={furigana} onChange={(e) => setFurigana(e.target.checked)} data-testid="seat-furigana" />
            ふりがなを付ける
          </label>
          {furigana && (
            <ReadingEditor
              participants={participants}
              readings={readings}
              missing={missingReadings}
              onChange={setReading}
              onPaste={(text) => {
                const r = readingsFromPaste(text, names);
                setReadings((prev) => ({ ...prev, ...r.readings }));
                return r;
              }}
            />
          )}
          <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
            タイトル
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={TITLE_BY_PURPOSE[purpose]}
              className="min-w-0 flex-1 rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
              data-testid="seat-title"
            />
          </label>
        </section>
      )}

      {purpose && model && (
        // 鍵の印の表示（プレビューの欄には置かない。生徒に見せる画面に、切り替えのスイッチを出さないため）
        <section className={sectionClass} aria-labelledby="seat-marks-heading" data-testid="seat-marks-section">
          <h2 id="seat-marks-heading" className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
            鍵をかけた席の確認
          </h2>
          <label className="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-200">
            <input type="checkbox" checked={showMarks} onChange={(e) => setShowMarks(e.target.checked)} className="mt-1" data-testid="seat-show-marks" />
            <span>
              プレビューに鍵の印（🔒）を表示する
              <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                鍵をかけた席を確かめたいときだけオンにします。生徒に画面を見せるときはオフにしておくと、どの席に鍵があるか分かりません。印刷・ダウンロードには、オンでも印は出ません。
              </span>
            </span>
          </label>
          {lockedSet.size > 0 && (
            <p className="text-xs text-neutral-600 dark:text-neutral-300" data-testid="seat-locked-count">
              鍵をかけた席：{lockedSet.size}席
            </p>
          )}
        </section>
      )}

      {purpose && model && (
        <ConditionsPanel
          names={names}
          rules={rules}
          onChange={(next) => {
            setRules(next);
            setRuleError(null);
          }}
          unmet={unmet}
          error={ruleError}
          maxCol={Math.max(1, ...colOf.map((c) => c + 1))}
          maxRow={Math.max(1, ...rowOf.map((r) => r + 1))}
          onApply={shuffle}
          canApply={canShuffle(slots, fixedSet) && participants.length > 0}
        />
      )}

      {purpose && model && (
        <section className={sectionClass} aria-labelledby="seat-step3">
          <h2 id="seat-step3" className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
            3. 書き出す
          </h2>
          <div role="radiogroup" aria-label="書き出す形式" className="flex flex-wrap gap-2">
            {FORMATS.map((f) => (
              <button
                key={f.value}
                type="button"
                role="radio"
                aria-checked={format === f.value}
                onClick={() => setFormat(f.value)}
                data-testid={`seat-format-${f.value}`}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  format === f.value ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {format === "pdf" && (
            <div className="flex flex-wrap items-center gap-3 text-sm text-neutral-700 dark:text-neutral-200">
              <label className="flex items-center gap-2 whitespace-nowrap">
                用紙
                <select value={paper} onChange={(e) => setPaper(e.target.value as PaperSize)} className={`${inputClass} w-auto`} data-testid="seat-paper">
                  {PAPER_SIZES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 whitespace-nowrap">
                向き
                <select value={paperOrientation} onChange={(e) => setPaperOrientation(e.target.value as PaperOrientation)} className={`${inputClass} w-auto`} data-testid="seat-paper-orientation">
                  <option value="auto">自動（表の形に合わせる）</option>
                  <option value="portrait">縦</option>
                  <option value="landscape">横</option>
                </select>
              </label>
            </div>
          )}
          <label className="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-200">
            <input type="checkbox" className="mt-1" checked={bothViews} onChange={(e) => setBothViews(e.target.checked)} data-testid="seat-both-views" />
            <span>
              前後を1ページに並べる
              <span className="block text-xs text-neutral-500 dark:text-neutral-400">前が上の向きと、上下を逆にした向き（前が下）を1枚に印刷します。前に立つ人と、席に座る人の両方がそのまま読めます。</span>
            </span>
          </label>
          <RewardedDownloadGate onDownload={download} label={`${FORMATS.find((f) => f.value === format)!.label}でダウンロード`} disabled={participants.length === 0} />
          {exportError && <ErrorMessage message={exportError} />}
        </section>
      )}
          </div>
          <div className="contents lg:order-1 lg:block lg:min-w-0 lg:self-start lg:sticky lg:top-20">
      {model && (
        <SeatPreview
          model={model}
          selected={selected}
          onToggle={toggleSelect}
          onSwap={swap}
          onShuffleSelected={shuffleSelected}
          onClearSelection={() => setSelected([])}
          onReset={resetOrder}
          canReset={manual !== null}
          locked={lockedSet}
          blocked={blockedSet}
          onToggleLock={toggleLock}
          onToggleBlocked={toggleBlocked}
          showMarks={showMarks}
          fullscreen={fullscreen}
          onFullscreenChange={setFullscreen}
          flipped={flipped}
          onFlippedChange={setFlipped}
          onShuffle={shuffle}
          canShuffle={canShuffle(slots, fixedSet) && participants.length > 0}
          onTag={tagSelected}
        />
      )}
          </div>
        </div>
      )}
    </div>
  );
}

function SeatPreview({
  model,
  selected,
  onToggle,
  onSwap,
  onShuffleSelected,
  onClearSelection,
  onReset,
  canReset,
  onTag,
  locked,
  blocked,
  onToggleLock,
  onToggleBlocked,
  showMarks,
  fullscreen,
  onFullscreenChange,
  flipped,
  onFlippedChange,
  onShuffle,
  canShuffle: shuffleEnabled,
}: {
  model: SeatingChartModel;
  /** 鍵の印をプレビューに出すか */
  showMarks: boolean;
  /** 画面いっぱいに大きく表示しているか */
  fullscreen: boolean;
  onFullscreenChange: (v: boolean) => void;
  /** 向きを逆にしている（前が下） */
  flipped: boolean;
  onFlippedChange: (v: boolean) => void;
  selected: number[];
  onTag: (text: string) => void;
  locked: ReadonlySet<number>;
  blocked: ReadonlySet<number>;
  onToggleLock: () => void;
  onToggleBlocked: () => void;
  onShuffle: () => void;
  canShuffle: boolean;
  onToggle: (i: number) => void;
  onSwap: (a: number, b: number) => void;
  onShuffleSelected: () => void;
  onClearSelection: () => void;
  onReset: () => void;
  canReset: boolean;
}) {
  const g = model.geometry;
  const [open, setOpen] = useState(true);
  const [boxW, setBoxW] = useState(800);
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ index: number; x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<{ index: number; dx: number; dy: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setBoxW(entry.contentRect.width));
    ro.observe(el);
    setBoxW(el.clientWidth);
    return () => ro.disconnect();
  }, [open, fullscreen]);

  const toolbarRef = useRef<HTMLDivElement>(null);
  const [maxH, setMaxH] = useState(440);
  useEffect(() => {
    const update = () => {
      if (fullscreen) {
        // 画面いっぱい：操作の段（ボタン・札の欄）を除いた高さを、すべて座席表に使う
        const bar = toolbarRef.current?.offsetHeight ?? 120;
        setMaxH(Math.max(200, window.innerHeight - bar - 40));
      } else if (window.innerWidth >= 1024) {
        // PC：プレビューを真ん中に大きく出す（画面の高さから、上のヘッダー・操作の段を除いた分）
        const bar = toolbarRef.current?.offsetHeight ?? 60;
        setMaxH(Math.max(240, window.innerHeight - bar - 140));
      } else {
        setMaxH(Math.max(180, Math.min(window.innerHeight * 0.38, 480)));
      }
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [fullscreen, selected.length]);

  // 大きく表示しているときは、Esc で戻る。後ろのページはスクロールさせない
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onFullscreenChange(false);
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [fullscreen, onFullscreenChange]);

  // 大きく表示しているときは、文字が読みやすいよう、元の大きさより大きくしてよい（最大2倍）
  const maxScale = fullscreen ? 2 : 1;
  const scale = Math.max(0.3, Math.min(maxScale, (boxW - 4) / g.width, maxH / g.height));

  function seatAt(clientX: number, clientY: number, except: number): number | null {
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      const v = (el as HTMLElement).dataset?.seatIndex;
      if (v !== undefined && Number(v) !== except) return Number(v);
    }
    return null;
  }

  const seatStyle = (x: number, y: number, i: number): CSSProperties => ({
    left: x,
    top: y,
    width: SEAT_W,
    height: SEAT_H,
    transform: drag?.index === i ? `translate(${drag.dx / scale}px, ${drag.dy / scale}px)` : undefined,
    zIndex: drag?.index === i ? 10 : undefined,
    pointerEvents: drag?.index === i ? "none" : undefined,
    touchAction: "none",
  });

  const content = (
    <section
      className={
        fullscreen
          ? "fixed inset-0 z-[100] flex flex-col gap-2 overflow-hidden bg-white p-4 dark:bg-neutral-950"
          : "sticky bottom-0 z-20 -mx-4 flex flex-col gap-2 rounded-t-xl border border-neutral-200 bg-white p-3 shadow-[0_-8px_24px_-12px_rgba(15,23,42,0.35)] sm:-mx-6 lg:bottom-auto lg:top-20 lg:mx-0 lg:self-start lg:rounded-xl lg:shadow-sm dark:border-neutral-800 dark:bg-neutral-950"
      }
      aria-label="座席表のプレビュー"
      data-testid="tool-preview"
      data-fullscreen={fullscreen ? "true" : undefined}
      role={fullscreen ? "dialog" : undefined}
      aria-modal={fullscreen ? true : undefined}
      data-page-drop-ok={fullscreen ? "true" : undefined}
    >
      <div ref={toolbarRef} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {fullscreen ? (
          <button type="button" onClick={() => onFullscreenChange(false)} className="ms-focus-ring rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white" data-testid="seat-fullscreen-close">
            ✕ 閉じる（Esc）
          </button>
        ) : (
          <>
            <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className={`${smallButton} lg:hidden`} data-testid="seat-preview-toggle">
              {open ? "▼ たたむ" : "▲ プレビュー"}
            </button>
            <button type="button" onClick={() => { setOpen(true); onFullscreenChange(true); }} className="ms-focus-ring rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white" data-testid="seat-fullscreen" title="座席表を画面いっぱいに大きく表示します（入れ替え・シャッフルもできます）">
              ⛶ 大きく表示
            </button>
          </>
        )}
        {fullscreen && <span className="text-xs text-neutral-500 sm:hidden dark:text-neutral-400">スマホは横向きにすると、大きく見えます</span>}
        <p className="text-xs text-neutral-600 dark:text-neutral-300" data-testid="seat-swap-help">
          入れ替え：席をドラッグ、または2人を選んで［入れ替え］
        </p>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => onFlippedChange(!flipped)}
            aria-pressed={flipped}
            className={smallButton}
            data-testid="seat-flip"
            title="座席表の向きを逆にします（前が上：後ろから見た向き／前が下：前から見た向き）。印刷・ダウンロードにも反映されます"
          >
            ⇅ {flipped ? "前を上にする" : "前を下にする"}
          </button>
          <button type="button" disabled={!shuffleEnabled} onClick={onShuffle} className={smallButton} data-testid="seat-shuffle" title="鍵をかけた席はそのままにして、ほかの席をランダムに並べ替えます">
            シャッフル
          </button>
          {selected.length <= 2 && (
            <button
              type="button"
              disabled={selected.length !== 2 || selected.some((i) => locked.has(i) || blocked.has(i))}
              onClick={() => onSwap(selected[0], selected[1])}
              className="ms-focus-ring rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
              data-testid="seat-swap"
            >
              入れ替え{selected.length > 0 ? `（${selected.length}/2）` : ""}
            </button>
          )}
          <button type="button" disabled={!canReset} onClick={onReset} className={smallButton} data-testid="seat-reset">
            入力順に戻す
          </button>
        </div>
      </div>
      {selected.length > 0 && (
        // 選んだ席の操作（札・鍵・空席）は、プレビューのすぐ上に出す（PC・スマホ・大きく表示のどれでも）
        <SelectionPanel
          selected={selected}
          locked={locked}
          blocked={blocked}
          showMarks={showMarks}
          onTag={onTag}
          onToggleLock={onToggleLock}
          onToggleBlocked={onToggleBlocked}
          onShuffleSelected={onShuffleSelected}
          onClearSelection={onClearSelection}
        />
      )}
      </div>
      {open && (
        <div ref={boxRef} className="overflow-auto" style={{ maxHeight: maxH + 8 }}>
          <div style={{ width: g.width * scale, height: g.height * scale }} className="relative mx-auto">
            <div className="absolute left-0 top-0 origin-top-left" style={{ width: g.width, height: g.height, transform: `scale(${scale})` }}>
              {g.shapes.map((sh, k) =>
                sh.kind === "rect" ? (
                  <div key={k} className="absolute flex items-center justify-center rounded-lg border border-slate-300 bg-slate-100 text-[13px] text-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300" style={{ left: sh.x, top: sh.y, width: sh.w, height: sh.h }}>
                    {sh.label}
                  </div>
                ) : (
                  <div key={k} className="absolute flex items-center justify-center rounded-full border border-slate-300 bg-slate-100 text-[14px] text-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300" style={{ left: sh.cx - sh.r, top: sh.cy - sh.r, width: sh.r * 2, height: sh.r * 2 }}>
                    {sh.label}
                  </div>
                )
              )}
              {g.marks.map((m, k) => (
                <div key={k} className="absolute flex items-center justify-center rounded-md bg-slate-700 text-[14px] font-bold text-white" style={{ left: m.x, top: m.y, width: m.w, height: 30 }}>
                  {m.text}
                </div>
              ))}
              {g.seats.map((seat, i) => {
                const person = model.assignment[i];
                const isSel = selected.includes(i);
                const isHover = hover === i;
                const isLocked = locked.has(i);
                // 印を出さないときは、鍵の席も見た目をほかの席と同じにする（生徒に分からないように）
                const showLock = showMarks && isLocked;
                const isBlocked = blocked.has(i);
                const reading = model.furigana ? (person?.reading ?? "") : "";
                return (
                  <button
                    key={i}
                    type="button"
                    data-seat-index={i}
                    data-testid="seat"
                    data-name={person?.name ?? ""}
                    data-locked={isLocked ? "true" : undefined}
                    data-blocked={isBlocked ? "true" : undefined}
                    aria-pressed={isSel}
                    aria-label={`席${i + 1}${model.tags?.[i] ? `［${model.tags[i]}］` : ""}：${person ? `${person.name}${person.role ? `（${person.role}）` : ""}` : isBlocked ? "空席（空席にした席）" : "空席"}${isLocked ? "・鍵" : ""}`}
                    className={`ms-focus-ring absolute flex ${showLock || isBlocked ? "cursor-pointer" : "cursor-grab"} select-none flex-col items-center justify-center rounded-lg border px-1.5 text-center shadow-sm active:cursor-grabbing ${
                      isSel
                        ? "border-blue-600 bg-blue-50 ring-4 ring-blue-500/60 dark:bg-blue-950"
                        : isHover
                          ? "border-emerald-500 bg-emerald-50 ring-4 ring-emerald-400/60 dark:bg-emerald-950"
                          : person
                            ? showLock
                              ? "border-slate-500 bg-slate-100 dark:border-slate-400 dark:bg-slate-800"
                              : "border-slate-400 bg-white dark:border-slate-500 dark:bg-slate-900"
                            : isBlocked
                              ? "border-slate-300 bg-[repeating-linear-gradient(45deg,#f1f5f9_0,#f1f5f9_6px,#e2e8f0_6px,#e2e8f0_12px)] dark:border-slate-600 dark:bg-[repeating-linear-gradient(45deg,#1e293b_0,#1e293b_6px,#0f172a_6px,#0f172a_12px)]"
                              : "border-dashed border-slate-300 bg-slate-50 dark:border-slate-600 dark:bg-slate-900/60"
                    }`}
                    style={seatStyle(seat.x, seat.y, i)}
                    onPointerDown={(e) => {
                      if (e.button !== 0 || isLocked || isBlocked) return;
                      dragRef.current = { index: i, x: e.clientX, y: e.clientY, moved: false };
                      e.currentTarget.setPointerCapture(e.pointerId);
                    }}
                    onPointerMove={(e) => {
                      const d = dragRef.current;
                      if (!d) return;
                      const dx = e.clientX - d.x;
                      const dy = e.clientY - d.y;
                      if (!d.moved && Math.hypot(dx, dy) < 6) return;
                      d.moved = true;
                      setDrag({ index: d.index, dx, dy });
                      setHover(seatAt(e.clientX, e.clientY, d.index));
                    }}
                    onPointerUp={(e) => {
                      const d = dragRef.current;
                      dragRef.current = null;
                      if (d?.moved) {
                        suppressClick.current = true;
                        const target = seatAt(e.clientX, e.clientY, d.index);
                        if (target !== null) onSwap(d.index, target);
                      }
                      setDrag(null);
                      setHover(null);
                    }}
                    onPointerCancel={() => {
                      dragRef.current = null;
                      setDrag(null);
                      setHover(null);
                    }}
                    onClick={() => {
                      if (suppressClick.current) {
                        suppressClick.current = false;
                        return;
                      }
                      onToggle(i);
                    }}
                  >
                    <span className="absolute left-1.5 top-0.5 text-[10px] text-slate-400">{i + 1}</span>
                    {model.tags?.[i] && (
                      <span className="absolute right-1 top-0.5 max-w-[70%] truncate rounded bg-amber-300 px-1.5 text-[10px] font-bold leading-4 text-amber-950" data-testid="seat-tag">
                        {model.tags[i]}
                      </span>
                    )}
                    {isBlocked && !person && (
                      <span className="text-[14px] font-bold text-slate-400 dark:text-slate-500" data-testid="seat-blocked-label">
                        空席
                      </span>
                    )}
                    {showLock && (
                      <span className="absolute bottom-0.5 right-1 text-[11px] leading-none" aria-hidden="true" data-testid="seat-lock-icon">
                        🔒
                      </span>
                    )}
                    {person && (
                      <>
                        {reading && (
                          <span className="max-w-full truncate text-[10px] leading-tight text-slate-500 dark:text-slate-400" data-testid="seat-reading-text">
                            {reading}
                          </span>
                        )}
                        <span className="max-w-full truncate text-[16px] font-bold leading-tight text-slate-900 dark:text-slate-100">
                          {model.numbers && person.number && (
                            <span className="mr-1 text-blue-700 dark:text-blue-300" data-testid="seat-number">
                              {person.number}
                            </span>
                          )}
                          {person.name}
                        </span>
                        {person.role && <span className="max-w-full truncate text-[11px] leading-tight text-slate-500 dark:text-slate-400">{person.role}</span>}
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
  // 大きく表示するときは、ページの外枠（ぼかし・重なりの設定）に影響されないよう、body の直下に出す
  return fullscreen && typeof document !== "undefined" ? createPortal(content, document.body) : content;
}


/** 選んだ席の操作（札・鍵・空席・列の固定）。ふだんは右のメニュー、大きく表示しているときはプレビューの上に出す */
function SelectionPanel({
  selected,
  locked,
  blocked,
  showMarks,
  onTag,
  onToggleLock,
  onToggleBlocked,
  onShuffleSelected,
  onClearSelection,
  className = "",
}: {
  selected: number[];
  locked: ReadonlySet<number>;
  blocked: ReadonlySet<number>;
  showMarks: boolean;
  onTag: (text: string) => void;
  onToggleLock: () => void;
  onToggleBlocked: () => void;
  /** 選んだ席（3席以上）の中でシャッフル */
  onShuffleSelected: () => void;
  onClearSelection: () => void;
  className?: string;
}) {
  const [tagText, setTagText] = useState("");
  // シャッフルできる席（鍵・空席を除く）
  const movable = selected.filter((i) => !locked.has(i) && !blocked.has(i)).length;
  return (
        <div className={`flex flex-wrap items-center gap-2 text-xs ${className}`} data-testid="seat-tag-bar">
          <span className="font-semibold text-neutral-700 dark:text-neutral-200" data-testid="seat-selected-count">
            {selected.length}席を選択中
          </span>
          {selected.length >= 3 && (
            <button
              type="button"
              onClick={onShuffleSelected}
              disabled={movable < 2}
              className="ms-focus-ring rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
              data-testid="seat-shuffle-selected"
              title="選んだ席の中だけで、人をランダムに並べ替えます（鍵・空席の席は動きません）"
            >
              選んだ{selected.length}席をシャッフル
            </button>
          )}
          <button type="button" onClick={onClearSelection} className={smallButton} data-testid="seat-clear-selection">
            選択を解除
          </button>
          <label className="flex items-center gap-1.5 text-neutral-700 dark:text-neutral-200">
            札
            <input
              type="text"
              list="seat-tag-presets"
              value={tagText}
              onChange={(e) => setTagText(e.target.value)}
              placeholder="来賓・司会など"
              maxLength={10}
              className="w-32 rounded-md border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
              data-testid="seat-tag-input"
            />
          </label>
          <datalist id="seat-tag-presets">
            {TAG_PRESETS.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          {TAG_PRESETS.slice(0, 4).map((t) => (
            <button key={t} type="button" className={smallButton} onClick={() => setTagText(t)}>
              {t}
            </button>
          ))}
          <button type="button" disabled={tagText.trim() === ""} onClick={() => { onTag(tagText); setTagText(""); }} className="ms-focus-ring rounded-lg bg-amber-400 px-3 py-1.5 text-xs font-semibold text-amber-950 disabled:opacity-40" data-testid="seat-tag-apply">
            札を付ける
          </button>
          <button type="button" onClick={() => onTag("")} className={smallButton} data-testid="seat-tag-clear">
            札を外す
          </button>
          <button type="button" onClick={onToggleLock} className={smallButton} data-testid="seat-lock">
            {selected.every((i) => locked.has(i)) ? "🔓 鍵を外す" : "🔒 鍵をかける"}
          </button>
          <button type="button" onClick={onToggleBlocked} className={smallButton} data-testid="seat-block">
            {selected.every((i) => blocked.has(i)) ? "空席を戻す" : "空席にする"}
          </button>
          {showMarks && selected.some((i) => locked.has(i)) && (
            <span className="text-neutral-500 dark:text-neutral-400">鍵をかけた席は、入れ替え・シャッフルで動きません</span>
          )}
        </div>
  );
}


/**
 * 席の条件（隠せる欄）。だれとだれを離す・近くにする・どの列にする・今の列のまま。
 * 最初はたたんでおき、見出しには件数も出さない（生徒に見られても、条件があるか分からないように）。
 * 条件は、プレビュー・大きく表示・印刷・ダウンロードのどこにも出さない。
 */
function ConditionsPanel({
  names,
  rules,
  onChange,
  unmet,
  error,
  maxCol,
  maxRow,
  onApply,
  canApply,
}: {
  names: string[];
  rules: SeatRule[];
  onChange: (next: SeatRule[]) => void;
  unmet: SeatRule[];
  error: string | null;
  maxCol: number;
  maxRow: number;
  onApply: () => void;
  canApply: boolean;
}) {
  const [open, setOpen] = useState(false);
  const nameSet = new Set(names);
  const unmetIds = new Set(unmet.map((r) => r.id));
  const warn = error !== null || unmet.length > 0;
  const select = "min-w-0 rounded-md border border-neutral-300 px-1.5 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100";
  const num = "w-12 rounded-md border border-neutral-300 px-1.5 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100";

  function update(id: string, patch: Partial<SeatRule>) {
    onChange(rules.map((r) => (r.id === id ? ({ ...r, ...patch } as SeatRule) : r)));
  }
  function changeKind(r: SeatRule, kind: SeatRule["kind"]) {
    const b = r.kind === "apart" || r.kind === "near" ? r.b : names.find((n) => n !== r.a) ?? "";
    const next: SeatRule =
      kind === "apart"
        ? { id: r.id, kind, a: r.a, b, n: 2 }
        : kind === "near"
          ? { id: r.id, kind, a: r.a, b }
          : kind === "place"
            ? { id: r.id, kind, a: r.a, axis: "row", from: 1, to: 1 }
            : { id: r.id, kind, a: r.a, axis: "col" };
    onChange(rules.map((x) => (x.id === r.id ? next : x)));
  }
  function add() {
    onChange([...rules, { id: `rule-${Date.now().toString(36)}-${rules.length}`, kind: "apart", a: names[0] ?? "", b: names[1] ?? "", n: 2 }]);
  }
  const personSelect = (value: string, onSel: (v: string) => void, testId: string) => (
    <select value={value} onChange={(e) => onSel(e.target.value)} className={`${select} max-w-[7.5rem]`} data-testid={testId}>
      {!nameSet.has(value) && <option value={value}>{value ? `${value}（名簿にいません）` : "選ぶ"}</option>}
      {names.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  );

  return (
    <section className={sectionClass} aria-label="席の条件" data-testid="seat-conditions">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex items-center gap-2 text-left text-sm font-semibold text-neutral-800 dark:text-neutral-100" data-testid="seat-conditions-toggle">
        <span aria-hidden="true">{open ? "▼" : "▶"}</span>
        席の条件
        {warn && !open && (
          <span className="rounded-full bg-amber-400 px-1.5 text-[10px] font-bold text-amber-950" title="満たしていない条件があります" data-testid="seat-conditions-warn">
            ！
          </span>
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-2" data-testid="seat-conditions-body">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            シャッフルするときに守る条件です。プレビュー・印刷・ダウンロードには表示されません。「離す」の席の数は、隣・前後・斜めを1席として数えます。
          </p>
          {rules.length === 0 && <p className="text-xs text-neutral-500 dark:text-neutral-400">条件はまだありません。</p>}
          <ul className="flex flex-col gap-2">
            {rules.map((r, k) => (
              <li
                key={r.id}
                className={`flex flex-col gap-1.5 rounded-lg border p-2 ${unmetIds.has(r.id) ? "border-amber-400 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30" : "border-neutral-200 dark:border-neutral-800"}`}
                data-testid="seat-rule"
                data-unmet={unmetIds.has(r.id) ? "true" : undefined}
              >
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-neutral-700 dark:text-neutral-200">
                  <span className="text-neutral-400">{k + 1}</span>
                  <select value={r.kind} onChange={(e) => changeKind(r, e.target.value as SeatRule["kind"])} className={select} data-testid="seat-rule-kind" aria-label="条件の種類">
                    <option value="apart">2人を離す</option>
                    <option value="near">2人を近くにする</option>
                    <option value="place">列を決める</option>
                    <option value="stay">今の列のまま</option>
                  </select>
                  <button type="button" onClick={() => onChange(rules.filter((x) => x.id !== r.id))} className="ml-auto rounded px-1.5 py-0.5 text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/40" data-testid="seat-rule-delete" aria-label={`条件${k + 1}を消す`}>
                    消す
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-neutral-700 dark:text-neutral-200">
                  {personSelect(r.a, (v) => update(r.id, { a: v }), "seat-rule-a")}
                  {(r.kind === "apart" || r.kind === "near") && (
                    <>
                      <span>と</span>
                      {personSelect(r.b, (v) => update(r.id, { b: v }), "seat-rule-b")}
                      {r.kind === "apart" ? (
                        <>
                          <span>を</span>
                          <input type="number" min={2} max={20} value={r.n} onChange={(e) => update(r.id, { n: Math.max(2, Math.min(20, Number(e.target.value) || 2)) })} className={num} data-testid="seat-rule-n" aria-label="離す席の数" />
                          <span>席以上離す</span>
                        </>
                      ) : (
                        <span>を隣・前後にする</span>
                      )}
                    </>
                  )}
                  {r.kind === "place" && (
                    <>
                      <span>を</span>
                      <select value={r.axis} onChange={(e) => update(r.id, { axis: e.target.value as "col" | "row", from: 1, to: 1 })} className={select} data-testid="seat-rule-axis" aria-label="列の向き">
                        <option value="row">前から</option>
                        <option value="col">左から</option>
                      </select>
                      <input type="number" min={1} max={r.axis === "col" ? maxCol : maxRow} value={r.from} onChange={(e) => { const v = Math.max(1, Number(e.target.value) || 1); update(r.id, { from: v, to: Math.max(v, r.to) }); }} className={num} data-testid="seat-rule-from" aria-label="何列目から" />
                      <span>〜</span>
                      <input type="number" min={1} max={r.axis === "col" ? maxCol : maxRow} value={r.to} onChange={(e) => { const v = Math.max(1, Number(e.target.value) || 1); update(r.id, { to: v, from: Math.min(v, r.from) }); }} className={num} data-testid="seat-rule-to" aria-label="何列目まで" />
                      <span>列目</span>
                    </>
                  )}
                  {r.kind === "stay" && (
                    <>
                      <span>を今の</span>
                      <select value={r.axis} onChange={(e) => update(r.id, { axis: e.target.value as "col" | "row" })} className={select} data-testid="seat-rule-axis" aria-label="列の向き">
                        <option value="col">縦の列</option>
                        <option value="row">横の列</option>
                      </select>
                      <span>のままにする</span>
                    </>
                  )}
                </div>
                {unmetIds.has(r.id) && <p className="text-[11px] text-amber-800 dark:text-amber-300">今の並びでは満たしていません（シャッフルすると、条件に合わせて並べ替えます）</p>}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={add} disabled={names.length === 0} className={smallButton} data-testid="seat-rule-add">
              ＋ 条件を追加
            </button>
            <button type="button" onClick={onApply} disabled={!canApply || rules.length === 0} className="ms-focus-ring rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40" data-testid="seat-rule-apply">
              条件に合わせてシャッフル
            </button>
          </div>
          {error && (
            <p role="alert" className="text-xs text-red-700 dark:text-red-400" data-testid="seat-rule-error">
              {error}
            </p>
          )}
          {rules.length > 0 && (
            <p className="sr-only">{rules.map(describeRule).join("。")}</p>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * ふりがなの入力欄（名前ごと）。名前をコピーして貼り付けたあとに、ふりがなだけを入れられる。
 * - Enterで次の人の欄へ移る（漢字変換の確定のEnterでは移らない）
 * - 「まとめて貼り付け」：Excelのふりがなの列をコピーして貼ると、上から順に入る
 * - 未入力の人は目立たせ、人数を出す（印刷する前に気づけるように）
 */
function ReadingEditor({
  participants,
  readings,
  missing,
  onChange,
  onPaste,
}: {
  participants: Participant[];
  readings: Record<string, string>;
  missing: number;
  onChange: (name: string, value: string) => void;
  onPaste: (text: string) => { used: number; extra: number };
}) {
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  if (participants.length === 0) {
    return <p className="text-xs text-neutral-500 dark:text-neutral-400">名前を入れると、ここでふりがなを入力できます。</p>;
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800" data-testid="seat-reading-editor">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">ふりがな</span>
        {missing > 0 ? (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950/60 dark:text-amber-100" data-testid="seat-reading-missing">
            未入力 {missing}人
          </span>
        ) : (
          <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200" data-testid="seat-reading-missing">
            全員入力済み
          </span>
        )}
        <button type="button" className={`${smallButton} ml-auto`} onClick={() => setPasteOpen((v) => !v)} aria-expanded={pasteOpen} data-testid="seat-reading-paste-toggle">
          まとめて貼り付け
        </button>
      </div>
      {pasteOpen && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">ふりがなを1行に1人ずつ貼り付けると、名前の上から順に入ります（Excelのふりがなの列をそのままコピーできます）。</p>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            rows={4}
            aria-label="ふりがなをまとめて貼り付け（1行に1人）"
            placeholder={"やまだ たろう\nさとう はなこ"}
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            data-testid="seat-reading-paste"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={pasteText.trim() === ""}
              onClick={() => {
                const r = onPaste(pasteText);
                setNote(`${r.used}人分のふりがなを入れました${r.extra > 0 ? `（名前より${r.extra}行多いため、余りは使っていません）` : ""}`);
                setPasteText("");
                setPasteOpen(false);
              }}
              className="ms-focus-ring rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
              data-testid="seat-reading-paste-apply"
            >
              上から順に入れる
            </button>
          </div>
        </div>
      )}
      {note && <p className="text-xs text-emerald-700 dark:text-emerald-300">{note}</p>}
      <div ref={listRef} className="grid max-h-72 grid-cols-1 gap-x-4 gap-y-1.5 overflow-auto pr-1 sm:grid-cols-2 lg:grid-cols-1" data-testid="seat-reading-list">
        {participants.map((p, i) => {
          const value = readings[p.name] ?? "";
          const empty = value.trim() === "";
          return (
            <label key={p.id} className="flex min-w-0 items-center gap-2 text-sm">
              <span className="w-28 shrink-0 truncate text-neutral-800 dark:text-neutral-100" title={p.name}>
                {p.name}
              </span>
              <input
                type="text"
                value={value}
                maxLength={40}
                onChange={(e) => onChange(p.name, e.target.value)}
                onBlur={(e) => {
                  const cleaned = cleanReading(e.target.value);
                  if (cleaned !== e.target.value) onChange(p.name, cleaned);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return;
                  e.preventDefault();
                  const inputs = listRef.current?.querySelectorAll<HTMLInputElement>('input[data-testid="seat-reading"]');
                  inputs?.[i + 1]?.focus();
                }}
                aria-label={`${p.name}のふりがな`}
                placeholder="ふりがな"
                className={`min-w-0 flex-1 rounded-md border px-2 py-1 text-sm dark:bg-neutral-900 dark:text-neutral-100 ${
                  empty ? "border-amber-400 bg-amber-50 dark:border-amber-600 dark:bg-amber-950/30" : "border-neutral-300 dark:border-neutral-700"
                }`}
                data-testid="seat-reading"
                data-empty={empty ? "true" : undefined}
              />
            </label>
          );
        })}
      </div>
    </div>
  );
}
