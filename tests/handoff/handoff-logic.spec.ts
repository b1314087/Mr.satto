import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { TOOL_HANDOFF } from "@/lib/handoff/config";
import { captureDownloads } from "@/lib/handoff/capture";
import { detectFileKindFromBytes } from "@/lib/handoff/file-kind";
import { buildHandoffPageProps, getHandoffTargets } from "@/lib/handoff/page-props";
import {
  HANDOFF_MAX_ENTRIES,
  HANDOFF_MAX_TOTAL_BYTES,
  HANDOFF_TTL_MS,
  HandoffStoreError,
  clearHandoffs,
  countHandoffs,
  putHandoff,
  takeHandoff,
} from "@/lib/handoff/store";
import { canReceiveFiles, describeNoTarget, findHandoffTargets, hasPotentialHandoffTargets } from "@/lib/handoff/targets";
import { HANDOFF_FILE_KIND_MIME, type HandoffFileInfo, type HandoffFileKind, type HandoffTarget } from "@/lib/handoff/types";
import { getToolById, isListedTool, tools } from "@/lib/tools/data";
import { hasImplementation } from "@/lib/tools/registry";
import { downloadBlob } from "@/lib/utils/format";
import { matchesAccept } from "@/lib/utils/file-accept";
import { GAIJI_FILE_ACCEPT, GAIJI_FILE_MAX_MB } from "@/lib/processors/browser/gaiji-files";

/**
 * 工程16：ツール間のファイル受け渡しの、判定・置き場・種類の判別・設定の整合のテスト（画面を使わない）。
 * 画面での受け渡しは tests/handoff/handoff-flow.spec.ts。
 */

const MB = 1024 * 1024;
const pdf = (size = 1000, name = "a.pdf"): HandoffFileInfo => ({ name, kind: "pdf", size });
const target = (id: string, kinds: HandoffTarget["receive"]["kinds"], maxFiles = 1, maxFileSizeMB = 50, requiredPlan: "standard" | "premium" = "standard"): HandoffTarget => ({
  id,
  name: id,
  receive: { kinds, maxFiles, maxFileSizeMB },
  requiredPlan,
});

// ---------------------------------------------------------------------------
// 1. 候補の判定（設定だけで決まる。ツールIDどうしの個別の条件はない）
// ---------------------------------------------------------------------------
test.describe("候補の判定", () => {
  const pdfEditor = target("pdf-a", ["pdf"], 1, 50);
  const imageEditor = target("img-a", ["png", "jpeg"], 1, 50);
  const anyMulti = target("zip-a", "any", 5, 200);
  const all = [pdfEditor, imageEditor, anyMulti];
  const source = { toolId: "src", send: { kinds: ["pdf"] as HandoffFileKind[] } };

  test("送り出しの設定がないツールからは、候補が出ない", () => {
    expect(findHandoffTargets({ toolId: "src" }, [pdf()], all, null)).toEqual([]);
    expect(hasPotentialHandoffTargets({ toolId: "src" }, all, null)).toBe(false);
  });

  test("形式が一致する送り先だけが候補になり、一致しない送り先は出ない", () => {
    const ids = findHandoffTargets(source, [pdf()], all, null).map((t) => t.id);
    expect(ids).toEqual(["pdf-a", "zip-a"]);
    expect(ids).not.toContain("img-a");
  });

  test("ファイル数・サイズの上限を超えると候補にならない（0バイトも渡さない）", () => {
    expect(findHandoffTargets(source, [pdf(), pdf()], all, null).map((t) => t.id)).toEqual(["zip-a"]);
    expect(findHandoffTargets(source, [pdf(50 * MB)], all, null).map((t) => t.id)).toEqual(["pdf-a", "zip-a"]);
    expect(findHandoffTargets(source, [pdf(50 * MB + 1)], all, null).map((t) => t.id)).toEqual(["zip-a"]);
    expect(findHandoffTargets(source, [pdf(0)], all, null)).toEqual([]);
    expect(canReceiveFiles(pdfEditor.receive, [])).toBe(false);
  });

  test("種類を判別できないファイルは、種類を問わない送り先にだけ渡せる", () => {
    const unknown: HandoffFileInfo = { name: "x.bin", kind: null, size: 10 };
    expect(findHandoffTargets(source, [unknown], all, null).map((t) => t.id)).toEqual(["zip-a"]);
  });

  test("受け渡しは有向：送り出しと受け取りの宣言の組み合わせでだけ成り立つ", () => {
    // A は PDF を送り出せるが受け取らない（生成ツール型）。B は PDF を受け取り、送り出しもできる
    const b = target("B", ["pdf"]);
    const receivers = [b]; // A は受け取りを宣言していないので、受け渡し先の一覧にそもそも入らない
    expect(findHandoffTargets({ toolId: "A", send: { kinds: ["pdf"] } }, [pdf()], receivers, null).map((t) => t.id)).toEqual(["B"]);
    expect(findHandoffTargets({ toolId: "B", send: { kinds: ["pdf"] } }, [pdf()], receivers, null)).toEqual([]);
  });

  test("自分自身・自分の総合ツールは候補にしない", () => {
    expect(findHandoffTargets({ toolId: "pdf-a", send: { kinds: ["pdf"] } }, [pdf()], all, null).map((t) => t.id)).toEqual(["zip-a"]);
    expect(
      findHandoffTargets({ toolId: "member", hubId: "pdf-a", send: { kinds: ["pdf"] } }, [pdf()], all, null).map((t) => t.id)
    ).toEqual(["zip-a"]);
  });

  test("利用者のプランで使えない送り先は候補にしない（受け渡しで有料機能を使えるようにしない）", () => {
    const premiumOnly = target("prem", ["pdf"], 1, 50, "premium");
    expect(findHandoffTargets(source, [pdf()], [premiumOnly], "free")).toEqual([]);
    expect(findHandoffTargets(source, [pdf()], [premiumOnly], "premium").map((t) => t.id)).toEqual(["prem"]);
  });

  test("候補がないときの理由（形式・数・サイズ）", () => {
    expect(describeNoTarget(source, [], all, null)).toContain("受け渡せるファイルがありません");
    const pdfOnly = [pdfEditor];
    expect(describeNoTarget(source, [{ name: "a.png", kind: "png", size: 1 }], pdfOnly, null)).toContain("この形式");
    expect(describeNoTarget(source, [pdf(), pdf()], pdfOnly, null)).toContain("2個");
    expect(describeNoTarget(source, [pdf(60 * MB)], pdfOnly, null)).toContain("大きすぎる");
  });
});

// ---------------------------------------------------------------------------
// 2. 実際の設定（config.ts）の整合
// ---------------------------------------------------------------------------
test.describe("設定の整合", () => {
  test("設定にあるツールIDはすべて実在し、実装がある", () => {
    for (const id of Object.keys(TOOL_HANDOFF)) {
      expect(getToolById(id), id).toBeTruthy();
      expect(hasImplementation(id), id).toBe(true);
    }
  });

  test("生成ツールは受け取らない。調べるツールは送り出さない", () => {
    for (const [id, spec] of Object.entries(TOOL_HANDOFF)) {
      if (spec.role === "generate") expect(spec.receive, `${id}（生成ツール）`).toBeUndefined();
      if (spec.role === "inspect") expect(spec.send, `${id}（調べるツール）`).toBeUndefined();
      expect(spec.receive || spec.send, `${id}：受け取りか送り出しのどちらかは必要`).toBeTruthy();
    }
  });

  test("受け渡し先の一覧：受け取りの設定がある・一覧に出る（統合済みの旧ページを除く）ツールだけ", () => {
    const targets = getHandoffTargets();
    const ids = targets.map((t) => t.id);
    for (const t of targets) {
      const tool = getToolById(t.id)!;
      expect(isListedTool(tool), t.id).toBe(true);
      expect(tool.handoff?.receive, t.id).toBeTruthy();
      expect(tool.handoff?.role, t.id).not.toBe("generate");
    }
    // 生成ツール・設定のないツール・統合済みの旧ページは入らない
    for (const id of ["qr-generator", "quote-order-generator", "fiscal-calendar", "shift-schedule", "invoice-generator", "csv-format", "pdf-rotate", "pdf-edit"]) {
      expect(ids, id).not.toContain(id);
    }
    // 設定のないツールは handoff を持たない（無条件に許可しない）
    expect(getToolById("csv-format")!.handoff).toBeUndefined();
    expect(tools.filter((t) => t.handoff).length).toBe(Object.keys(TOOL_HANDOFF).length);
  });

  test("統合済みの旧ページ（/tools/pdf-rotate）は、総合ツールの送り出し設定を使い、受け取りはしない", () => {
    const props = buildHandoffPageProps(getToolById("pdf-rotate")!, "premium");
    expect(props.hubId).toBe("pdf-edit");
    expect(props.toolName).toBe("PDF編集");
    expect(props.send).toEqual(TOOL_HANDOFF["pdf-edit"].send);
    expect(props.receive).toBeUndefined();
    expect(props.receiveBlockedReason).toBeNull();
  });

  test("代表的な経路：生成→編集・変換は候補になり、編集→生成は候補にならない", () => {
    const targets = getHandoffTargets();
    const png: HandoffFileInfo = { name: "qrcode.png", kind: "png", size: 2000 };
    const fromQr = findHandoffTargets({ toolId: "qr-generator", send: TOOL_HANDOFF["qr-generator"].send }, [png], targets, "premium").map((t) => t.id);
    expect(fromQr).toEqual(expect.arrayContaining(["image-resize", "image-format-convert", "image-to-pdf", "file-zip"]));
    expect(fromQr.some((id) => getToolById(id)!.handoff!.role === "generate")).toBe(false);
    expect(fromQr).not.toContain("pdf-compress");

    const fromPdfEdit = findHandoffTargets({ toolId: "pdf-rotate", hubId: "pdf-edit", send: TOOL_HANDOFF["pdf-edit"].send }, [pdf()], targets, "premium").map((t) => t.id);
    expect(fromPdfEdit).toEqual(expect.arrayContaining(["pdf-fix", "pdf-compress", "pdf-to-image"]));
    expect(fromPdfEdit).not.toContain("pdf-edit");
    expect(fromPdfEdit).not.toContain("quote-order-generator");
    expect(fromPdfEdit).not.toContain("image-resize");

    // ZIPは展開せず、ZIPを受け取るツールにだけ渡す
    const zip: HandoffFileInfo = { name: "pages.zip", kind: "zip", size: 5000 };
    const fromZip = findHandoffTargets({ toolId: "pdf-to-image", send: TOOL_HANDOFF["pdf-to-image"].send }, [zip], targets, "premium").map((t) => t.id);
    expect(fromZip.sort()).toEqual(["file-hash", "file-unzip", "file-zip"]);
  });

  // 受け取りの設定と、受け取るツールの実際のファイル選択欄（形式・上限・複数可否）を照合する
  const IMPLEMENTATION_FILE: Record<string, string> = {
    "image-resize": "image-canvas-tool.tsx",
    "image-compress": "image-canvas-tool.tsx",
    "image-format-convert": "image-format-convert-tool.tsx",
    "image-crop": "image-crop-tool.tsx",
    "image-rotate-flip": "image-rotate-flip-tool.tsx",
    "image-grayscale": "image-grayscale-tool.tsx",
    "image-metadata-remove": "image-metadata-remove-tool.tsx",
    "image-watermark": "image-watermark-tool.tsx",
    "image-mosaic": "image-mosaic-tool.tsx",
    "image-sns-size": "image-sns-size-tool.tsx",
    "pdf-fix": "pdf-fill-annotate-tool.tsx",
    "pdf-redact": "pdf-redact-tool.tsx",
    "pdf-compress": "pdf-compress-tool.tsx",
    "pdf-metadata-remove": "pdf-metadata-remove-tool.tsx",
    "pdf-resize-pages": "pdf-resize-pages-tool.tsx",
    "pdf-crop-pages": "pdf-crop-pages-tool.tsx",
    "pdf-password-protect": "pdf-password-protect-tool.tsx",
    "image-to-pdf": "image-to-pdf-tool.tsx",
    "pdf-to-image": "pdf-to-image-tool.tsx",
    "pdf-to-text": "pdf-to-text-tool.tsx",
    "pdf-to-word": "pdf-to-word-tool.tsx",
    "pdf-to-excel": "pdf-to-excel-tool.tsx",
    ocr: "ocr-tool.tsx",
    "word-to-pdf": "word-to-pdf-tool.tsx",
    "excel-to-pdf": "excel-to-pdf-tool.tsx",
    "excel-csv-convert": "excel-to-csv-tool.tsx",
    "csv-dedupe": "csv-dedupe-tool.tsx",
    "csv-replace": "csv-replace-tool.tsx",
    "csv-column-editor": "csv-column-editor-tool.tsx",
    "csv-merge": "csv-merge-tool.tsx",
    "excel-transpose": "excel-transpose-tool.tsx",
    "excel-blank-remove": "excel-blank-remove-tool.tsx",
    "excel-replace": "excel-replace-tool.tsx",
    "excel-merge-center": "excel-merge-center-tool.tsx",
    "excel-date-shift": "excel-date-shift-tool.tsx",
    "word-paragraph-cleanup": "word-paragraph-cleanup-tool.tsx",
    "word-renumber": "word-renumber-tool.tsx",
    "pptx-invert": "pptx-invert-tool.tsx",
    "gaiji-checker": "gaiji-checker-tool.tsx",
    "file-hash": "file-hash-tool.tsx",
    "file-zip": "file-zip-tool.tsx",
    "file-unzip": "file-unzip-tool.tsx",
  };
  // 別ファイルで定義された定数（ファイル内の const で解決できないもの）
  const IMPORTED: Record<string, string | number> = { GAIJI_FILE_ACCEPT, GAIJI_FILE_MAX_MB };

  function resolve(code: string, raw: string | undefined): string | number | undefined {
    if (raw === undefined) return undefined;
    const literal = /^"([^"]*)"$/.exec(raw) ?? /^\{"([^"]*)"\}$/.exec(raw);
    if (literal) return literal[1];
    const num = /^\{(\d+)\}$/.exec(raw);
    if (num) return Number(num[1]);
    const ident = /^\{([A-Z_][A-Z0-9_]*)\}$/.exec(raw)?.[1];
    if (!ident) throw new Error(`解決できない値: ${raw}`);
    if (ident in IMPORTED) return IMPORTED[ident];
    const def = new RegExp(`const ${ident}\\s*=\\s*\\n?\\s*("([^"]*)"|(\\d+))`).exec(code);
    if (!def) throw new Error(`定数が見つからない: ${ident}`);
    return def[2] !== undefined ? def[2] : Number(def[3]);
  }

  test("受け取りの設定は、受け取るツールの最初のファイル選択欄と一致する（形式・上限・複数可否）", () => {
    const receivers = Object.entries(TOOL_HANDOFF).filter(([, s]) => s.receive);
    expect(Object.keys(IMPLEMENTATION_FILE).sort()).toEqual(receivers.map(([id]) => id).sort());
    for (const [id, spec] of receivers) {
      const receive = spec.receive!;
      const file = path.join(process.cwd(), "src/components/tools/implementations", IMPLEMENTATION_FILE[id]);
      const code = fs.readFileSync(file, "utf-8");
      const start = code.indexOf("<FileDropzone");
      expect(start, `${id}: ファイル選択欄がある`).toBeGreaterThan(-1);
      const block = code.slice(start, code.indexOf("/>", start));
      const accept = resolve(code, /accept=("[^"]*"|\{[^}]*\})/.exec(block)?.[1]) as string | undefined;
      const maxSize = (resolve(code, /maxSizeMB=(\{[^}]*\})/.exec(block)?.[1]) as number | undefined) ?? 50;
      const multiple = /\bmultiple\b/.test(block);
      expect(receive.maxFileSizeMB, `${id}: 上限MB`).toBe(maxSize);
      expect(receive.maxFiles > 1, `${id}: 複数を受け取るか`).toBe(multiple);
      expect(/acceptHandoff=\{false\}/.test(block), `${id}: 最初の欄が受け取る`).toBe(false);
      if (receive.kinds === "any") {
        expect(accept, `${id}: 種類を問わない`).toBeUndefined();
      } else {
        for (const kind of receive.kinds) {
          const ext = kind === "jpeg" ? "jpg" : kind;
          expect(matchesAccept({ name: `sample.${ext}`, type: HANDOFF_FILE_KIND_MIME[kind] }, accept ?? ""), `${id}: ${kind}`).toBe(true);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. 一時置き場（メモリ上・識別子・期限・1回だけ・上限）
// ---------------------------------------------------------------------------
test.describe("一時置き場", () => {
  test.beforeEach(() => clearHandoffs());
  test.afterEach(() => clearHandoffs());
  const file = (name = "a.pdf", size = 10) => new File([new Uint8Array(size)], name, { type: "application/pdf" });
  const entry = (targetToolId = "pdf-fix", files = [file()]) => ({ sourceToolId: "pdf-edit", sourceName: "PDF編集", targetToolId, files });

  test("受け取れるのは1回だけで、受け取ると置き場から消える。名前・形式は保たれる", () => {
    const id = putHandoff(entry());
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const first = takeHandoff(id, "pdf-fix");
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.entry.files[0].name).toBe("a.pdf");
      expect(first.entry.files[0].type).toBe("application/pdf");
      expect(first.entry.sourceName).toBe("PDF編集");
    }
    expect(countHandoffs()).toBe(0);
    expect(takeHandoff(id, "pdf-fix")).toEqual({ ok: false, reason: "not-found" });
  });

  test("存在しない・不正な識別子は安全に断る", () => {
    expect(takeHandoff("00000000-0000-4000-8000-000000000000", "pdf-fix")).toEqual({ ok: false, reason: "not-found" });
    expect(takeHandoff("../../etc", "pdf-fix")).toEqual({ ok: false, reason: "invalid" });
    expect(takeHandoff("", "pdf-fix")).toEqual({ ok: false, reason: "invalid" });
  });

  test("期限切れは受け取れず、置き場から消える", () => {
    const now = Date.now();
    const id = putHandoff(entry(), now);
    expect(takeHandoff(id, "pdf-fix", now + HANDOFF_TTL_MS + 1)).toEqual({ ok: false, reason: "expired" });
    expect(countHandoffs()).toBe(0);
  });

  test("宛先の違うツールは受け取れず、受け渡しも消えない（横取りしない）", () => {
    const id = putHandoff(entry("pdf-fix"));
    expect(takeHandoff(id, "pdf-compress")).toEqual({ ok: false, reason: "wrong-target" });
    expect(takeHandoff(id, "pdf-fix").ok).toBe(true);
  });

  test("古いものの掃除・件数と合計の上限", () => {
    const now = Date.now();
    putHandoff(entry(), now);
    // 期限切れのものは、次に置くときに掃除される
    putHandoff(entry(), now + HANDOFF_TTL_MS + 1);
    expect(countHandoffs()).toBe(1);
    for (let i = 0; i < HANDOFF_MAX_ENTRIES + 2; i++) putHandoff(entry(), now + HANDOFF_TTL_MS + 2);
    expect(countHandoffs()).toBe(HANDOFF_MAX_ENTRIES);
    const big = { size: HANDOFF_MAX_TOTAL_BYTES + 1, name: "big.pdf", type: "application/pdf" } as File;
    expect(() => putHandoff(entry("pdf-fix", [big]))).toThrow(HandoffStoreError);
    expect(() => putHandoff(entry("pdf-fix", []))).toThrow(HandoffStoreError);
  });

  test("置き場・受け渡しの部品は、通信・ブラウザへの保存・ログを使わない。URLには識別子だけを付ける", () => {
    const files = ["src/lib/handoff/store.ts", "src/lib/handoff/capture.ts", "src/lib/handoff/file-kind.ts", "src/lib/handoff/targets.ts", "src/components/handoff/handoff-provider.tsx", "src/components/handoff/handoff-send.tsx"];
    for (const f of files) {
      const code = fs
        .readFileSync(path.join(process.cwd(), f), "utf-8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "document.cookie", "fetch(", "XMLHttpRequest", "sendBeacon", "console."]) {
        expect(code, `${f}: ${forbidden}`).not.toContain(forbidden);
      }
    }
    const send = fs.readFileSync(path.join(process.cwd(), "src/components/handoff/handoff-send.tsx"), "utf-8");
    expect(send).toContain("router.push(`/tools/${target.id}?${HANDOFF_QUERY_KEY}=${id}`)");
    // 受け渡しは、ダウンロードと同じ関所（広告の確認）を通す
    expect(send).toContain("runWithDownloadAccess(");
  });
});

// ---------------------------------------------------------------------------
// 4. 種類の判別・結果の受け取り
// ---------------------------------------------------------------------------
test.describe("種類の判別と結果の受け取り", () => {
  const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0x20)].slice(0, 16));

  test("先頭のバイトで判別し、拡張子だけでは決めない", () => {
    expect(detectFileKindFromBytes(bytes(0x25, 0x50, 0x44, 0x46, 0x2d), "x.png")).toBe("pdf");
    expect(detectFileKindFromBytes(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), "x.bin")).toBe("png");
    expect(detectFileKindFromBytes(bytes(0xff, 0xd8, 0xff), "x.jpg")).toBe("jpeg");
    // 中身がPDFでない「.pdf」は、PDFと判別しない
    expect(detectFileKindFromBytes(bytes(0x68, 0x65, 0x6c, 0x6c, 0x6f), "fake.pdf")).toBeNull();
    // Excel・Word・ZIP は、ZIPの中身であることを確かめたうえで拡張子で区別する
    expect(detectFileKindFromBytes(bytes(0x50, 0x4b, 0x03, 0x04), "a.xlsx")).toBe("xlsx");
    expect(detectFileKindFromBytes(bytes(0x50, 0x4b, 0x03, 0x04), "a.zip")).toBe("zip");
    expect(detectFileKindFromBytes(bytes(0x68, 0x69), "a.xlsx")).toBeNull();
    expect(detectFileKindFromBytes(bytes(0x50, 0x4b, 0x03, 0x04), "a.epub")).toBeNull();
    // テキストは拡張子で決め、バイナリ（0バイトを含む）は除く
    expect(detectFileKindFromBytes(new TextEncoder().encode("a,b\n1,2"), "a.csv")).toBe("csv");
    expect(detectFileKindFromBytes(new Uint8Array([0x61, 0x00, 0x62]), "a.csv")).toBeNull();
  });

  test("受け取りモードの間、downloadBlob は保存せず、渡されたファイルを順番どおりに受け取る", async () => {
    const captured = await captureDownloads(async () => {
      downloadBlob(new Blob(["1"], { type: "text/csv" }), "one.csv");
      await Promise.resolve();
      downloadBlob(new Blob(["22"], { type: "text/csv" }), "two.csv");
    });
    expect(captured.map((c) => c.filename)).toEqual(["one.csv", "two.csv"]);
    expect(captured[1].blob.size).toBe(2);
    // 受け取りモードは終わっている（受け取りモードのまま残らない）
    const again = await captureDownloads(() => undefined);
    expect(again).toEqual([]);
  });
});
