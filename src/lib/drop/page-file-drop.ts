/**
 * ページ全体へのファイルのドロップ（ドラッグ&ドロップの全画面対応）の仕組み。
 *
 * ファイル選択欄（FileDropzone など）が「受け取り先」として登録すると、その欄まで運ばなくても、
 * ページのどこにファイルを落としても、その欄で選んだときと同じ処理に渡す。
 *
 * 決めごと：
 * - 受け取り先が「ちょうど1つ」のときだけ働く。2つ以上の欄が同時に出ている画面（入力欄が複数あるツール）では、
 *   どの欄へ渡すべきか決められないため、全画面のドロップはしない（これまでどおり、各欄へのドロップだけ）。
 * - 外部からのファイルのドラッグだけを対象にする。ページ内の文字・画像・リンクのドラッグ（dragstart が
 *   このページで起きたもの）や、ファイルを含まないドラッグには反応せず、ブラウザの通常の動作も止めない。
 * - ブラウザのイベントの受付（window への登録）は、受け取り先が1つ以上あるあいだだけ。最後の受け取り先が
 *   なくなったら外す（ページの移動・画面の破棄で残らない）。
 * - ドラッグ中の表示は、ドロップ・ドラッグの中断・画面外への移動・ページ内のドラッグ終了・一定時間ドラッグの
 *   通知がないとき（Escキーでの中断など）に、必ず消す。
 * - フォルダのドロップは受け付けない。ダイアログ（確認画面）が開いているあいだは受け付けない。
 * - ファイルの中身は読まない・送らない・保存しない。受け取ったファイルは、受け取り先の確認（形式・サイズ・数）へ渡すだけ。
 */

export interface PageDropTarget {
  /** ドロップされたファイルを、受け取り先の通常の入力処理へ渡す */
  onFiles: (files: File[]) => void;
  /** 受け付けられないドロップ（フォルダなど）の理由を伝える */
  onReject?: (message: string) => void;
}

export interface PageDropSnapshot {
  /** 外部のファイルがページの上でドラッグされているか */
  dragging: boolean;
  /** 全画面のドロップを受け取る受け取り先（1つだけのとき）の識別子。なければ null */
  activeId: number | null;
}

export const FOLDER_DROP_MESSAGE = "フォルダはドロップできません。ファイルを選んでドロップしてください。";

/** ドラッグの通知（dragover）がこの時間ないときは、ドラッグが終わったものとして表示を消す */
const IDLE_HIDE_MS = 600;

let nextId = 1;
const targets = new Map<number, PageDropTarget>();
const subscribers = new Set<() => void>();
let snapshot: PageDropSnapshot = { dragging: false, activeId: null };
let internalDrag = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let listening = false;

function activeId(): number | null {
  if (targets.size !== 1) return null;
  return targets.keys().next().value ?? null;
}

function publish(dragging: boolean): void {
  const next: PageDropSnapshot = { dragging: dragging && activeId() !== null, activeId: activeId() };
  if (next.dragging === snapshot.dragging && next.activeId === snapshot.activeId) return;
  snapshot = next;
  subscribers.forEach((fn) => fn());
}

function clearIdleTimer(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function hide(): void {
  clearIdleTimer();
  publish(false);
}

/** 外部からのファイルのドラッグか（ページ内のドラッグ・ファイルを含まないドラッグは除く） */
export function isExternalFileDrag(event: DragEvent, startedInPage: boolean): boolean {
  if (startedInPage) return false;
  const types = event.dataTransfer?.types;
  return types ? Array.from(types).includes("Files") : false;
}

/** ドロップの中にフォルダが含まれているか（ブラウザが判別できる場合） */
export function containsDirectory(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer?.items) return false;
  return Array.from(dataTransfer.items).some((item) => {
    if (item.kind !== "file") return false;
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => { isDirectory: boolean } | null }).webkitGetAsEntry?.();
    return entry?.isDirectory === true;
  });
}

function isModalOpen(): boolean {
  // プレビューを大きく表示している画面（data-page-drop-ok）は、ページの続きとして扱い、ドロップを受け付ける
  return document.querySelector('[role="dialog"][aria-modal="true"]:not([data-page-drop-ok])') !== null;
}

function onDragStart(): void {
  // このページの中で始まったドラッグ（文字・画像・リンク）。外部のファイルではない
  internalDrag = true;
}

function onDragEnd(): void {
  internalDrag = false;
  hide();
}

function onDragOver(event: DragEvent): void {
  if (activeId() === null || !isExternalFileDrag(event, internalDrag)) return;
  // ファイルを落とせる場所として扱う（これがないと、ブラウザがファイルを開いてしまう）
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  publish(true);
  clearIdleTimer();
  idleTimer = setTimeout(hide, IDLE_HIDE_MS);
}

function onDragLeave(event: DragEvent): void {
  // ウィンドウの外へ出た（行き先の要素がない）とき
  if (event.relatedTarget === null && snapshot.dragging) {
    const { clientX, clientY } = event;
    const outside = clientX <= 0 || clientY <= 0 || clientX >= window.innerWidth || clientY >= window.innerHeight;
    if (outside) hide();
  }
}

function onDrop(event: DragEvent): void {
  const wasInternal = internalDrag;
  internalDrag = false;
  const id = activeId();
  if (id === null || !isExternalFileDrag(event, wasInternal)) {
    hide();
    return;
  }
  // ファイル選択欄そのものへのドロップは、その欄がすでに処理している（二重に渡さない）
  const handledByZone = event.defaultPrevented;
  event.preventDefault();
  hide();
  if (handledByZone || isModalOpen()) return;
  const target = targets.get(id);
  if (!target) return;
  if (containsDirectory(event.dataTransfer)) {
    target.onReject?.(FOLDER_DROP_MESSAGE);
    return;
  }
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length === 0) return;
  target.onFiles(files);
}

function startListening(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("dragstart", onDragStart);
  window.addEventListener("dragend", onDragEnd);
  window.addEventListener("dragenter", onDragOver);
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("dragleave", onDragLeave);
  window.addEventListener("drop", onDrop);
}

function stopListening(): void {
  if (!listening) return;
  listening = false;
  window.removeEventListener("dragstart", onDragStart);
  window.removeEventListener("dragend", onDragEnd);
  window.removeEventListener("dragenter", onDragOver);
  window.removeEventListener("dragover", onDragOver);
  window.removeEventListener("dragleave", onDragLeave);
  window.removeEventListener("drop", onDrop);
  internalDrag = false;
  hide();
}

/** 受け取り先を登録する。戻り値は [識別子, 登録を外す関数] */
export function registerPageDropTarget(target: PageDropTarget): [number, () => void] {
  const id = nextId++;
  targets.set(id, target);
  startListening();
  publish(snapshot.dragging);
  return [
    id,
    () => {
      targets.delete(id);
      if (targets.size === 0) stopListening();
      else publish(snapshot.dragging);
    },
  ];
}

/** 登録済みの受け取り先の処理を差し替える（最新の入力処理を使うため。登録の順番は変えない） */
export function updatePageDropTarget(id: number, target: PageDropTarget): void {
  if (targets.has(id)) targets.set(id, target);
}

export function subscribePageDrop(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function getPageDropSnapshot(): PageDropSnapshot {
  return snapshot;
}

const SERVER_SNAPSHOT: PageDropSnapshot = { dragging: false, activeId: null };
export function getPageDropServerSnapshot(): PageDropSnapshot {
  return SERVER_SNAPSHOT;
}
