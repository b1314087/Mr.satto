import { sanitizeSurvey, type Survey } from "./model";

/**
 * 作成中のアンケートを、この端末のブラウザの中（localStorage）に1つだけ保存する（2026-11-17）。
 * - 利用者が「この端末に保存する」を選んだときだけ保存する（最初は保存しない。共用のパソコンで中身が残らないように）。
 *   保存をやめると、保存した内容はすぐに消す。
 * - サーバーへは送らない。保存するのは、画面で入力したアンケートの中身（文字と設定）だけ。
 * - ブラウザの設定（プライベートブラウズなど）で保存できないときは、保存せずにそのまま使える（エラーで止めない）。
 * - 読み込むときは、形を確かめてから使う（壊れたデータ・ほかのデータで画面が止まらないように）。
 */

export const SURVEY_STORAGE_KEY = "mr-satto:survey-sheet:draft:v1";

export interface SavedDraft {
  survey: Survey;
  savedAt: number;
}

export function loadDraft(): SavedDraft | null {
  try {
    const raw = window.localStorage.getItem(SURVEY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { survey?: unknown; savedAt?: unknown };
    const survey = sanitizeSurvey(parsed.survey);
    if (!survey) return null;
    return { survey, savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : Date.now() };
  } catch {
    return null;
  }
}

/** 保存できたら保存した時刻、できなかったら null */
export function saveDraft(survey: Survey): number | null {
  try {
    const savedAt = Date.now();
    window.localStorage.setItem(SURVEY_STORAGE_KEY, JSON.stringify({ survey, savedAt }));
    return savedAt;
  } catch {
    return null;
  }
}

export function clearDraft(): void {
  try {
    window.localStorage.removeItem(SURVEY_STORAGE_KEY);
  } catch {
    // 保存できない環境では、消すものもない
  }
}
