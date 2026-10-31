import { CATEGORY_INFO, SEVERITY_LABEL, shouldShowAsName, type GaijiFinding } from "@/lib/gaiji/detect";
import { csvRowsToBlob } from "@/lib/utils/csv";

/** 画面・CSVに出す、文字の見せ方（見えない文字などは、名前で見せる） */
export function displayOfFinding(f: GaijiFinding): string {
  if (shouldShowAsName(f.codePoint)) return `〔${f.name ?? "見えない文字"}〕`;
  return f.char;
}

/** 検出結果のCSV（共有・記録用）。元の文章は含めず、問題のある文字の一覧と、場所の例だけを出す */
export function findingsToCsvBlob(findings: GaijiFinding[]): Blob {
  const rows = [
    ["重要度", "分類", "文字", "コード", "名前", "件数", "場所の例", "対処"],
    ...findings.map((f) => {
      const info = CATEGORY_INFO[f.category];
      return [
        SEVERITY_LABEL[f.severity],
        info.label,
        displayOfFinding(f),
        f.hex,
        f.name ?? "",
        String(f.count),
        f.locations.join(" / ") + (f.moreLocations ? " ほか" : ""),
        f.replacement ? `${info.advice}（置き換え案：${f.replacement}）` : info.advice,
      ];
    }),
  ];
  return csvRowsToBlob(rows);
}
