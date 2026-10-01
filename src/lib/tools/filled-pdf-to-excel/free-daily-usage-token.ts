import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Free（匿名・未ログイン）ユーザーの、記入済みPDF→Excelの1日あたり利用回数を、
 * サーバー側で検証可能な署名付きトークンとして扱う実装（利用制限見直しで追加）。
 *
 * Standardプランの利用回数（daily-usage.ts）はSupabaseの
 * tool_usage_daily（auth.uid()ベース）で管理しているが、Free（匿名）
 * ユーザーはログインしておらずuser_idを持たないため、同じ仕組みは使えない
 * （supabase/migrations/0002_tool_usage_daily.sqlのget_tool_usage_today()も
 * 「未ログインはこのテーブルの対象外」と明記している）。
 *
 * そのため、credit-token.ts と同じHMAC署名の設計を踏襲した、Cookie保存の
 * 署名付きトークン（日付＋回数）で代替する。ただし以下の限界がある
 * （開発指示書7章で明示的に許容されている制約。大きな認証基盤を新設して
 * 解決することはしない）：
 *   - Cookie削除・別ブラウザ・シークレットウィンドウの利用で回避できる
 *   - IPアドレス等、より強い匿名識別は行わない（共有回線の誤判定・
 *     プライバシーへの配慮のため、意図的に採用しない）
 *   - あくまで「ライトユーザーの意図しない大量利用を抑止する」ための
 *     軽量な仕組みであり、悪意ある利用者の完全な防止を保証するものではない
 *
 * 署名により「Cookieの中身（回数・日付）を書き換えて上限を偽装する」
 * ことは防げるが、「Cookie自体を削除してリセットする」ことまでは
 * 構造的に防げない（匿名である以上、これはCookie方式の原理的な限界）。
 */

const TOKEN_VERSION = "pxfd1";

function getSecret(): string {
  // credit-token.ts / temp-access-token.ts と同じ秘密鍵を再利用する
  // （新しい環境変数を増やさないため）。トークン種別はTOKEN_VERSIONで
  // 分離しているため、誤って別種のトークンとして検証されることはない。
  const secret = process.env.TEMP_ACCESS_SECRET;
  if (!secret) {
    throw new Error(
      "TEMP_ACCESS_SECRET が設定されていません。記入済みPDF→ExcelのFreeプラン" +
        "利用回数を管理するには、この環境変数の設定が必要です。"
    );
  }
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

/**
 * 日本時間(Asia/Tokyo)での「今日の日付」をYYYY-MM-DD形式で返す。
 * daily-usage.ts（Supabase側の `(now() at time zone 'Asia/Tokyo')::date`）と
 * 日付境界の考え方を揃える。
 */
export function getJstDateString(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(at);
}

export interface FreeDailyUsageState {
  /** トークンに記録されていた日付（JST）。無効・未発行の場合はnull */
  date: string | null;
  /** その日付時点での利用回数。無効・未発行の場合は0 */
  count: number;
}

/** 指定した日付・回数を署名付きトークン文字列にする */
export function issueFreeDailyUsageToken(date: string, count: number): string {
  const payload = `${TOKEN_VERSION}.${date}.${count}`;
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

/**
 * トークンを検証し、記録されていた日付・回数を返す。
 * 署名不一致・形式不正の場合は { date: null, count: 0 } を返す
 * （不正・破損したCookieを受け取っても安全側＝「未使用」として扱う）。
 * 日付が今日(JST)と異なる場合（日付が変わった場合）も、呼び出し側が
 * 「今日の回数として0から数え直す」ことを期待できるよう、dateとcountは
 * トークンの内容をそのまま返す（「今日かどうか」の判定は呼び出し側が行う）。
 */
export function verifyFreeDailyUsageToken(token: string | undefined | null): FreeDailyUsageState {
  if (!token) return { date: null, count: 0 };

  const parts = token.split(".");
  if (parts.length !== 4) return { date: null, count: 0 };

  const [version, date, countRaw, signature] = parts;
  if (version !== TOKEN_VERSION) return { date: null, count: 0 };

  const count = Number(countRaw);
  if (!Number.isInteger(count) || count < 0) return { date: null, count: 0 };

  let signatureValid: boolean;
  try {
    const expectedSignature = sign(`${version}.${date}.${countRaw}`);
    const a = Buffer.from(signature);
    const b = Buffer.from(expectedSignature);
    signatureValid = a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return { date: null, count: 0 };
  }

  if (!signatureValid) return { date: null, count: 0 };

  return { date, count };
}
