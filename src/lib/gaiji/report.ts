import { shouldShowAsName, type GaijiFinding } from "@/lib/gaiji/detect";

/** 画面に出す、文字の見せ方（見えない文字などは、名前で見せる） */
export function displayOfFinding(f: GaijiFinding): string {
  if (shouldShowAsName(f.codePoint)) return `〔${f.name ?? "見えない文字"}〕`;
  return f.char;
}
