/**
 * 差し込み印刷・レイアウト作成：レイアウトの保存（ブラウザの IndexedDB）と、JSONの書き出し・読み込み。
 *
 * - 保存先は、この端末のブラウザの中だけ（サーバーには送らない）。ブラウザのデータを消すと、保存したレイアウトも消える。
 * - レイアウト（用紙・項目・列の紐付け）は "layouts" に、背景のPDFは、利用者が選んだときだけ "templates" に、別々に保存する
 *   （一覧を出すときに、大きなPDFまで読み込まないため）。
 * - 保存に失敗したとき（容量の上限など）は、例外を投げる。画面は成功と表示しない。
 * - JSONの書き出しには、PDF本体を含めない。読み込むときは中身を確かめ、おかしなJSONは受け付けない。
 */

import {
  FIELD_LIMITS,
  PAPER_MAX_MM,
  PAPER_MIN_MM,
  PAPER_PRESETS,
  type FieldSource,
  type MergeField,
  type PaperSetting,
} from "./layout";

export const LAYOUT_JSON_KIND = "mr-satto-mail-merge-layout";
export const LAYOUT_JSON_VERSION = 1;
export const LAYOUT_NAME_MAX = 50;
export const MAX_FIELDS = 60;
/** JSONとして読み込むファイルの大きさの上限（PDF本体は入らないので、これで十分） */
export const LAYOUT_JSON_MAX_BYTES = 1024 * 1024;

/** 保存するレイアウトの中身（JSONの書き出しと同じ形） */
export interface LayoutBody {
  paper: PaperSetting;
  fields: MergeField[];
  /** 項目ID → 差し込む文字の決め方。列名で持つ（同じ列名のExcelなら、そのまま使える） */
  sources: Record<string, FieldSource>;
  /** 背景のPDFのファイル名（PDF本体は含めない。参考に表示するだけ） */
  templateName: string | null;
  /** 背景のPDFの何ページ目を使うか（1から） */
  templatePage: number;
}

export interface SavedLayout extends LayoutBody {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** 背景のPDFを一緒に保存しているか */
  hasTemplate: boolean;
  templateBytes?: number;
}

export class LayoutStorageError extends Error {}

const DB_NAME = "mr-satto-mail-merge";
const DB_VERSION = 1;
const STORE_LAYOUTS = "layouts";
const STORE_TEMPLATES = "templates";

export function isStorageAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isStorageAvailable()) {
      reject(new LayoutStorageError("このブラウザでは保存機能を使えません（プライベートブラウズ中などは使えないことがあります）。"));
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      reject(new LayoutStorageError("保存場所を開けませんでした。ブラウザの設定で、サイトのデータの保存が許可されているか確かめてください。"));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_LAYOUTS)) db.createObjectStore(STORE_LAYOUTS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_TEMPLATES)) db.createObjectStore(STORE_TEMPLATES);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new LayoutStorageError("保存場所を開けませんでした。ブラウザの設定で、サイトのデータの保存が許可されているか確かめてください。"));
    req.onblocked = () => reject(new LayoutStorageError("ほかのタブがこのツールを開いているため、保存場所を開けませんでした。ほかのタブを閉じてから、やり直してください。"));
  });
}

function isQuotaError(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name ?? "";
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

function toStorageError(e: unknown, action: string): LayoutStorageError {
  if (e instanceof LayoutStorageError) return e;
  if (isQuotaError(e)) {
    return new LayoutStorageError(
      `${action}できませんでした。ブラウザの保存容量が足りません。背景のPDFを保存しないようにするか、使わないレイアウトを削除してから、やり直してください。`
    );
  }
  return new LayoutStorageError(`${action}できませんでした。もう一度お試しください。`);
}

/** 1つのトランザクションで処理し、完了（書き込みの確定）まで待つ */
async function run<T>(stores: string[], mode: IDBTransactionMode, action: string, fn: (tx: IDBTransaction) => T | Promise<T>): Promise<T> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch (e) {
    throw toStorageError(e, action);
  }
  try {
    return await new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(stores, mode);
      } catch (e) {
        reject(e);
        return;
      }
      let result: T;
      let failed: unknown = null;
      tx.oncomplete = () => (failed ? reject(failed) : resolve(result));
      tx.onerror = () => reject(tx.error ?? failed);
      tx.onabort = () => reject(tx.error ?? failed ?? new Error("aborted"));
      Promise.resolve()
        .then(() => fn(tx))
        .then(
          (r) => {
            result = r;
          },
          (e) => {
            failed = e;
            try {
              tx.abort();
            } catch {
              /* すでに終わっている */
            }
          }
        );
    });
  } catch (e) {
    throw toStorageError(e, action);
  } finally {
    db.close();
  }
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `l-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function cleanLayoutName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, LAYOUT_NAME_MAX);
}

/** 保存したレイアウトの一覧（新しく更新した順） */
export async function listLayouts(): Promise<SavedLayout[]> {
  const rows = await run([STORE_LAYOUTS], "readonly", "保存したレイアウトを読み込み", (tx) => req(tx.objectStore(STORE_LAYOUTS).getAll()));
  return (rows as SavedLayout[]).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 新しく保存する。template を渡したときだけ、背景のPDFも保存する */
export async function saveNewLayout(name: string, body: LayoutBody, template: Blob | null): Promise<SavedLayout> {
  const clean = cleanLayoutName(name);
  if (!clean) throw new LayoutStorageError("レイアウトの名前を入力してください。");
  const now = Date.now();
  const layout: SavedLayout = {
    ...structuredClone(body),
    id: newId(),
    name: clean,
    createdAt: now,
    updatedAt: now,
    hasTemplate: !!template,
    templateBytes: template?.size,
  };
  await run([STORE_LAYOUTS, STORE_TEMPLATES], "readwrite", "保存", async (tx) => {
    tx.objectStore(STORE_LAYOUTS).put(layout);
    if (template) tx.objectStore(STORE_TEMPLATES).put(template, layout.id);
  });
  return layout;
}

/**
 * 上書き保存する。template：Blob＝背景のPDFを保存（置き換え）、null＝保存しない（前に保存したPDFも消す）。
 */
export async function overwriteLayout(id: string, body: LayoutBody, template: Blob | null): Promise<SavedLayout> {
  return run([STORE_LAYOUTS, STORE_TEMPLATES], "readwrite", "上書き保存", async (tx) => {
    const store = tx.objectStore(STORE_LAYOUTS);
    const prev = (await req(store.get(id))) as SavedLayout | undefined;
    if (!prev) throw new LayoutStorageError("上書きするレイアウトが見つかりません。削除された可能性があります。");
    const next: SavedLayout = {
      ...structuredClone(body),
      id,
      name: prev.name,
      createdAt: prev.createdAt,
      updatedAt: Date.now(),
      hasTemplate: !!template,
      templateBytes: template?.size,
    };
    store.put(next);
    if (template) tx.objectStore(STORE_TEMPLATES).put(template, id);
    else tx.objectStore(STORE_TEMPLATES).delete(id);
    return next;
  });
}

export async function renameLayout(id: string, name: string): Promise<void> {
  const clean = cleanLayoutName(name);
  if (!clean) throw new LayoutStorageError("レイアウトの名前を入力してください。");
  await run([STORE_LAYOUTS], "readwrite", "名前の変更", async (tx) => {
    const store = tx.objectStore(STORE_LAYOUTS);
    const prev = (await req(store.get(id))) as SavedLayout | undefined;
    if (!prev) throw new LayoutStorageError("レイアウトが見つかりません。削除された可能性があります。");
    store.put({ ...prev, name: clean, updatedAt: Date.now() });
  });
}

/** 複製する（背景のPDFを保存していれば、それも複製する） */
export async function duplicateLayout(id: string): Promise<SavedLayout> {
  return run([STORE_LAYOUTS, STORE_TEMPLATES], "readwrite", "複製", async (tx) => {
    const store = tx.objectStore(STORE_LAYOUTS);
    const prev = (await req(store.get(id))) as SavedLayout | undefined;
    if (!prev) throw new LayoutStorageError("複製するレイアウトが見つかりません。削除された可能性があります。");
    const now = Date.now();
    const copy: SavedLayout = { ...prev, id: newId(), name: cleanLayoutName(`${prev.name}のコピー`), createdAt: now, updatedAt: now };
    store.put(copy);
    if (prev.hasTemplate) {
      const blob = (await req(tx.objectStore(STORE_TEMPLATES).get(id))) as Blob | undefined;
      if (blob) tx.objectStore(STORE_TEMPLATES).put(blob, copy.id);
      else {
        copy.hasTemplate = false;
        store.put(copy);
      }
    }
    return copy;
  });
}

export async function deleteLayout(id: string): Promise<void> {
  await run([STORE_LAYOUTS, STORE_TEMPLATES], "readwrite", "削除", (tx) => {
    tx.objectStore(STORE_LAYOUTS).delete(id);
    tx.objectStore(STORE_TEMPLATES).delete(id);
  });
}

/** 保存した背景のPDFを読み込む（保存していなければ null） */
export async function loadTemplate(id: string): Promise<Blob | null> {
  const blob = await run([STORE_TEMPLATES], "readonly", "背景のPDFの読み込み", (tx) => req(tx.objectStore(STORE_TEMPLATES).get(id)));
  return (blob as Blob | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// JSONの書き出し・読み込み
// ---------------------------------------------------------------------------

export function layoutToJson(name: string, body: LayoutBody): string {
  return JSON.stringify(
    {
      kind: LAYOUT_JSON_KIND,
      version: LAYOUT_JSON_VERSION,
      name: cleanLayoutName(name) || "レイアウト",
      paper: body.paper,
      fields: body.fields,
      sources: body.sources,
      templateName: body.templateName,
      templatePage: body.templatePage,
    },
    null,
    2
  );
}

export class LayoutJsonError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function bad(msg: string): never {
  throw new LayoutJsonError(`このJSONは読み込めません（${msg}）。このツールで書き出したレイアウトのJSONを選んでください。`);
}

function parseField(v: unknown, i: number): MergeField {
  const where = `項目${i + 1}`;
  if (!isObj(v)) bad(`${where}の形式が正しくありません`);
  if (!isStr(v.id, 64) || !v.id) bad(`${where}のIDが正しくありません`);
  if (!isStr(v.name, FIELD_LIMITS.name)) bad(`${where}の項目名が正しくありません`);
  for (const k of ["xMm", "yMm"] as const) if (!isNum(v[k], FIELD_LIMITS.mm[0], FIELD_LIMITS.mm[1])) bad(`${where}の位置が正しくありません`);
  for (const k of ["maxWidthMm", "maxHeightMm"] as const) if (!isNum(v[k], FIELD_LIMITS.boxMm[0], FIELD_LIMITS.boxMm[1])) bad(`${where}の最大幅・最大高さが正しくありません`);
  if (!isNum(v.sizePt, FIELD_LIMITS.sizePt[0], FIELD_LIMITS.sizePt[1])) bad(`${where}の文字サイズが正しくありません`);
  if (v.font !== "gothic" && v.font !== "mincho") bad(`${where}のフォントが正しくありません`);
  if (typeof v.color !== "string" || !COLOR_RE.test(v.color)) bad(`${where}の文字色が正しくありません`);
  if (v.align !== "left" && v.align !== "center" && v.align !== "right") bad(`${where}の横位置が正しくありません`);
  if (v.vAlign !== "top" && v.vAlign !== "middle" && v.vAlign !== "bottom") bad(`${where}の縦位置が正しくありません`);
  if (v.direction !== "horizontal" && v.direction !== "vertical") bad(`${where}の書字方向が正しくありません`);
  const prefix = v.prefix === undefined ? "" : v.prefix;
  const suffix = v.suffix === undefined ? "" : v.suffix;
  if (!isStr(prefix, FIELD_LIMITS.affix) || !isStr(suffix, FIELD_LIMITS.affix)) bad(`${where}の前後の文字が正しくありません`);
  const shrink = v.shrinkToFit === undefined ? false : v.shrinkToFit;
  if (typeof shrink !== "boolean") bad(`${where}の設定が正しくありません`);
  return {
    id: v.id,
    name: v.name,
    xMm: v.xMm as number,
    yMm: v.yMm as number,
    sizePt: v.sizePt,
    font: v.font,
    color: v.color.toLowerCase(),
    align: v.align,
    vAlign: v.vAlign,
    direction: v.direction,
    maxWidthMm: v.maxWidthMm as number,
    maxHeightMm: v.maxHeightMm as number,
    shrinkToFit: shrink,
    prefix,
    suffix,
  };
}

/** JSONの文字を確かめて、レイアウトにする。おかしなところがあれば LayoutJsonError を投げる */
export function parseLayoutJson(text: string): { name: string; body: LayoutBody } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    bad("JSONの書式が正しくありません");
  }
  if (!isObj(data)) bad("形式が正しくありません");
  if (data.kind !== LAYOUT_JSON_KIND) bad("このツールのレイアウトではありません");
  if (data.version !== LAYOUT_JSON_VERSION) bad("対応していない版のレイアウトです");
  const p = data.paper;
  if (!isObj(p)) bad("用紙の設定がありません");
  if (p.mode !== "pdf" && p.mode !== "blank") bad("用紙の種類が正しくありません");
  if (typeof p.presetId !== "string" || !PAPER_PRESETS.some((x) => x.id === p.presetId)) bad("用紙の大きさが正しくありません");
  if (p.orientation !== "portrait" && p.orientation !== "landscape") bad("用紙の向きが正しくありません");
  if (!isNum(p.widthMm, PAPER_MIN_MM, PAPER_MAX_MM) || !isNum(p.heightMm, PAPER_MIN_MM, PAPER_MAX_MM)) bad("用紙の幅・高さが正しくありません");
  if (!Array.isArray(data.fields)) bad("項目の一覧がありません");
  if (data.fields.length > MAX_FIELDS) bad(`項目が多すぎます（${MAX_FIELDS}個まで）`);
  const fields = data.fields.map(parseField);
  const ids = new Set(fields.map((f) => f.id));
  if (ids.size !== fields.length) bad("同じIDの項目があります");
  const sources: Record<string, FieldSource> = {};
  if (data.sources !== undefined) {
    if (!isObj(data.sources)) bad("列の紐付けが正しくありません");
    for (const [key, s] of Object.entries(data.sources)) {
      if (!ids.has(key)) continue;
      if (!isObj(s)) bad("列の紐付けが正しくありません");
      if (s.kind === "column" && isStr(s.column, 200)) sources[key] = { kind: "column", column: s.column };
      else if (s.kind === "fixed" && isStr(s.text, 2000)) sources[key] = { kind: "fixed", text: s.text };
      else if (s.kind === "none") sources[key] = { kind: "none" };
      else bad("列の紐付けが正しくありません");
    }
  }
  const templateName = data.templateName === null || data.templateName === undefined ? null : isStr(data.templateName, 300) ? data.templateName : bad("背景のPDFの名前が正しくありません");
  const templatePage = data.templatePage === undefined ? 1 : isNum(data.templatePage, 1, 100000) ? Math.floor(data.templatePage) : bad("背景のPDFのページが正しくありません");
  const name = isStr(data.name, 500) ? cleanLayoutName(data.name) || "読み込んだレイアウト" : "読み込んだレイアウト";
  return {
    name,
    body: {
      paper: { mode: p.mode, presetId: p.presetId as PaperSetting["presetId"], orientation: p.orientation, widthMm: p.widthMm as number, heightMm: p.heightMm as number },
      fields,
      sources,
      templateName,
      templatePage,
    },
  };
}
