import {
  LOW_CONFIDENCE_THRESHOLD,
  TOTAL_MAX_YEN,
  VENDOR_MAX_LENGTH,
  type FieldCandidate,
  type FieldExtraction,
  type ReceiptExtraction,
  type TextLine,
} from "./receipt-types";

/**
 * 領収書・レシートの文字（OCRの結果、またはPDFの文字情報）から、日付・取引先・合計金額の候補を取り出す（工程8）。
 *
 * 方針:
 * - 純粋な関数だけで作る（画面・通信・OCRに依存しない）。OCRの出力を模した文字列でテストできる。
 * - 判断できないときは、値を空にして、候補と理由を返す。推測した値を確定値にしない。
 *   value は「自動で入力欄に入れてよい」と言えるときだけ入る。入った値も、利用者が確認するまで「未確認」のまま扱われる。
 * - OCRの信頼度が高いことは、意味（合計か小計か、など）を正しく読めたことを保証しない。信頼度は「確認を促す印」にだけ使う。
 *
 * 注意: 古いSafariで構文エラーになる「後読み」の正規表現は使わない（このリポジトリの既存コードと同じ方針）。
 */

// ---------------------------------------------------------------------------
// 文字の正規化
// ---------------------------------------------------------------------------

const CJK = "\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uff66-\\uff9f";
const CJK_SPACE_RE = new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, "g");

/** 行の文字を、比較・検索しやすい形にそろえる（全角の数字・記号を半角に、連続する空白を1つに） */
export function normalizeLineText(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** OCRが日本語の文字の間に入れる空白を取り除く（「株 式 会 社」→「株式会社」）。英数字どうしの空白は残す */
export function compactCjkSpaces(text: string): string {
  return text.replace(CJK_SPACE_RE, "$1");
}

/** 円記号がOCRで「\」や「Y」に読まれることへの対応（数字の直前にあるものだけを「¥」にそろえる） */
function normalizeYenMarks(text: string): string {
  return text.replace(/\\(?=\s?\d)/g, "¥").replace(/(^|[^A-Za-z0-9])Y(?=\s?\d)/g, "$1¥");
}

interface PreparedLine {
  index: number;
  /** 日付・金額の検索用（空白を残した正規化済みの文字） */
  text: string;
  /** 取引先の検索用（日本語の文字の間の空白を取り除いたもの） */
  compact: string;
  confidence: number | null;
}

function prepareLines(lines: TextLine[]): PreparedLine[] {
  const out: PreparedLine[] = [];
  for (const line of lines) {
    const text = normalizeYenMarks(normalizeLineText(line.text));
    if (text === "") continue;
    out.push({ index: out.length, text, compact: compactCjkSpaces(text), confidence: line.confidence });
  }
  return out;
}

function isLowConfidence(confidence: number | null): boolean {
  return confidence !== null && confidence < LOW_CONFIDENCE_THRESHOLD;
}

function emptyField(note: string | null): FieldExtraction {
  return { value: null, candidates: [], note, lowConfidence: false };
}

// ---------------------------------------------------------------------------
// 日付
// ---------------------------------------------------------------------------

const MIN_YEAR = 1989;
const MAX_YEAR = 2099;

/** 取引日ではない日付の行（支払期限・有効期限など）。この行の日付は候補にしない */
const NOT_TRANSACTION_DATE = /期限|有効|締切|締め切り|納期|支払期日|お支払日|満期|生年月日|賞味|返品|引換|予約|お届け|配送|配達|発送|出荷|到着|予定|期間|開始|終了/;
/** 取引日・発行日を示す語（候補の理由に使う） */
const DATE_LABEL = /発行日|取引日|領収日|日付|ご利用日|利用日|お買い?上げ?日|購入日|日時|年月日|請求日|納品日|ご来店日|伝票日/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 年・月・日が実在する日付か確かめて、YYYY-MM-DD にする。実在しなければ null */
export function toIsoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

interface DateHit {
  iso: string;
  lineIndex: number;
  /** 年が2桁で、西暦かどうか確定できない日付（候補にはするが、自動では入れない） */
  twoDigitYear: boolean;
  excluded: boolean;
  labeled: boolean;
}

function findDates(line: PreparedLine): DateHit[] {
  const hits: DateHit[] = [];
  const text = line.text;
  const excluded = NOT_TRANSACTION_DATE.test(text);
  const labeled = DATE_LABEL.test(text);
  const add = (iso: string | null, twoDigitYear: boolean) => {
    if (iso) hits.push({ iso, lineIndex: line.index, twoDigitYear, excluded, labeled });
  };

  // 西暦（2026/10/31、2026-10-31、2026.10.31、2026年10月31日）
  const western = /(^|\D)((?:19|20)\d{2})\s*(?:年|[/.\-])\s*(\d{1,2})\s*(?:月|[/.\-])\s*(\d{1,2})\s*日?(?!\d)/g;
  for (const m of text.matchAll(western)) add(toIsoDate(Number(m[2]), Number(m[3]), Number(m[4])), false);

  // 和暦（令和8年10月31日、R8.10.31、平成30年1月5日、H30/1/5）
  const era = /(^|[^A-Za-z0-9])(令和|平成|R|H)\s*(元|\d{1,2})\s*(?:年|[/.\-])\s*(\d{1,2})\s*(?:月|[/.\-])\s*(\d{1,2})\s*日?(?!\d)/g;
  for (const m of text.matchAll(era)) {
    const n = m[3] === "元" ? 1 : Number(m[3]);
    const isReiwa = m[2] === "令和" || m[2] === "R";
    if (n < 1 || n > (isReiwa ? 40 : 31)) continue;
    add(toIsoDate((isReiwa ? 2018 : 1988) + n, Number(m[4]), Number(m[5])), false);
  }

  // 年が2桁（26/10/31）。西暦か日本の年号かなどを確定できないため、候補にだけする
  const twoDigit = /(^|[^\d/.\-])(\d{2})[/.\-](\d{1,2})[/.\-](\d{1,2})(?![\d/.\-])/g;
  for (const m of text.matchAll(twoDigit)) add(toIsoDate(2000 + Number(m[2]), Number(m[3]), Number(m[4])), true);

  return hits;
}

/** YYYY-MM-DD を、利用者に見せる「YYYY/MM/DD」にする */
export function formatDateSlash(iso: string): string {
  return iso.replace(/-/g, "/");
}

export function extractDate(lines: TextLine[]): FieldExtraction {
  return extractDateFromPrepared(prepareLines(lines));
}

/** 取引日・発行日などの表記がある行（その行の日付が読み取れなかった場合、別の行の日付を取引日として自動で入れない） */
const STRICT_DATE_LABEL = /(?:注文|発行|取引|領収|購入|利用|請求|納品|来店|伝票|売上|決済|お買い?上げ?)日|日時|年月日|日付/;

function extractDateFromPrepared(prepared: PreparedLine[]): FieldExtraction {
  const all = prepared.flatMap(findDates);
  const usable = all.filter((h) => !h.excluded && !h.twoDigitYear);
  // 「注文日」などの表記があり、数字も含むのに、日付として読めない行がある（桁が文字に読まれた、など）。
  // その場合、ほかの日付が1つだけ見つかっても、それが取引日とは限らないため、自動では入れない。
  const unreadableDateLine = prepared.some(
    (line) => STRICT_DATE_LABEL.test(compactCjkSpaces(line.text)) && /\d/.test(line.text) && !NOT_TRANSACTION_DATE.test(line.text) && !all.some((h) => h.lineIndex === line.index),
  );
  const distinct = new Map<string, DateHit>();
  for (const hit of usable) {
    const prev = distinct.get(hit.iso);
    if (!prev || (hit.labeled && !prev.labeled)) distinct.set(hit.iso, hit);
  }
  const toCandidate = (hit: DateHit): FieldCandidate => ({
    value: hit.iso,
    reason: hit.labeled ? `日付の表記がある行の日付（${formatDateSlash(hit.iso)}）` : `書類に書かれている日付（${formatDateSlash(hit.iso)}）`,
  });

  if (distinct.size === 1 && unreadableDateLine) {
    const hit = [...distinct.values()][0];
    return {
      value: null,
      candidates: [toCandidate(hit)],
      note: "「日付」などの表記がある行を読み取れませんでした。見つかった日付が取引日か確認して、選ぶか入力してください。",
      lowConfidence: false,
    };
  }
  if (distinct.size === 1) {
    const hit = [...distinct.values()][0];
    return {
      value: hit.iso,
      candidates: [toCandidate(hit)],
      note: null,
      lowConfidence: isLowConfidence(prepared[hit.lineIndex]?.confidence ?? null),
    };
  }

  if (distinct.size > 1) {
    const ordered = [...distinct.values()].sort((a, b) => Number(b.labeled) - Number(a.labeled) || a.lineIndex - b.lineIndex);
    return {
      value: null,
      candidates: ordered.map(toCandidate),
      note: "日付が複数見つかりました。取引日（発行日）を選ぶか、入力してください。",
      lowConfidence: false,
    };
  }

  const twoDigit = new Map<string, DateHit>();
  for (const hit of all.filter((h) => !h.excluded && h.twoDigitYear)) if (!twoDigit.has(hit.iso)) twoDigit.set(hit.iso, hit);
  if (twoDigit.size > 0) {
    return {
      value: null,
      candidates: [...twoDigit.values()].map((hit) => ({
        value: hit.iso,
        reason: `年が2桁の日付（${formatDateSlash(hit.iso)}）。西暦として読んだ候補です`,
      })),
      note: "年が2桁の日付だけが見つかりました。自動では入れていないため、確認して選ぶか、入力してください。",
      lowConfidence: false,
    };
  }

  if (all.some((h) => h.excluded)) {
    return emptyField("支払期限・有効期限などの日付だけが見つかりました。取引日は自動では入れていません。");
  }
  return emptyField("日付を見つけられませんでした。入力してください。");
}

// ---------------------------------------------------------------------------
// 合計金額
// ---------------------------------------------------------------------------

/** 合計金額ではない金額の表記（小計・消費税・預り・釣り・割引・点数・決済の方法など） */
const EXCLUDE_LABEL =
  /小計|SUB\s?TOTAL|消費税|税額|内税|外税|税率|%|対象|預|あずかり|釣|つり|現金|ポイント|割引|値引|クーポン|差引|点数|数量|個数|枚数|電話|TEL|FAX|会員|カード|クレジット|VISA|Master|JCB|Suica|PayPay|QR|電子マネー|承認|伝票|レジ|端末|番号|No\.?|登録|手数料|送料|サービス料|内消費/i;
/** 合計金額を示す表記 */
const STRONG_LABEL =
  /総合計|合計|お会計|お支払|ご請求|請求金額|請求額|領収金額|領収額|税込(?:合計|金額|計|額)?|お買い?上げ?(?:金額|計|合計)|ご利用(?:金額|額)|総額|TOTAL|AMOUNT/i;
const WEAK_LABEL = /計/;

interface AmountHit {
  /** 金額（円）。桁の読み取りが不確かな場合（suspect）は、つなげて読んだ場合の金額。つなげられないときは 0 */
  yen: number;
  lineIndex: number;
  kind: "strong" | "weak" | "neutral";
  /** 候補の理由に使う、金額の直前の表記 */
  label: string;
  /**
   * 桁の読み取りが不確かな金額（桁区切りが空白に読まれた「1 320」、先頭の文字が欠けた「l,320」、数字が文字に読まれた「1,32O」など）。
   * 一部だけを金額として読むと、「1」「320」のような誤った値を自動入力してしまうため、自動では入れない。
   */
  suspect: boolean;
}

/** 数字のすぐ後ろに付く単位。日付・時刻・番号・個数などの数字を、金額として読まないために使う */
const UNIT_AFTER = /^\s*(点|個|枚|品|%|倍|回|名|人|本|台|冊|箱|袋|g|kg|ml|l|cm|mm|年|月|日|時|分|秒|号|番|階|室|条|歳|才)/i;

function findAmounts(lines: PreparedLine[]): AmountHit[] {
  const hits: AmountHit[] = [];
  lines.forEach((line, lineNo) => {
    const text = line.text;
    const re = /(¥)?\s*(\d{1,3}(?:[,.]\d{3})+|\d+)(\s*円)?/g;
    const matches = [...text.matchAll(re)];
    let previousEnd = 0;
    for (const m of matches) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      const digitStart = start + m[0].indexOf(m[2]);
      const digitEnd = digitStart + m[2].length;
      const label = text.slice(previousEnd, start).slice(-24).trim();
      const previousEndBefore = previousEnd;
      previousEnd = end;

      const hasYenMark = Boolean(m[1]) || Boolean(m[3]);
      const prevChar = digitStart > 0 ? text[digitStart - 1] : "";
      const nextChar = text[digitEnd] ?? "";
      const afterNext = text[digitEnd + 1] ?? "";
      const rest = text.slice(digitEnd);

      // 英数字・記号の一部（No.123、TEL03-…、12:30、2026/10/31 など）は金額としない
      if (!m[1] && /[0-9A-Za-z\-/.:#]/.test(prevChar)) continue;
      if ((nextChar === "." || nextChar === "/" || nextChar === ":" || nextChar === "-") && /\d/.test(afterNext)) continue;
      if (UNIT_AFTER.test(rest)) {
        // 「合計 5点 ¥2,340」のように、個数などの数字の後ろに金額が続くときは、その前の表記（合計）を、次の金額の表記として引き継ぐ
        previousEnd = previousEndBefore;
        continue;
      }

      const digits = m[2].replace(/[,.]/g, "");
      if (digits.length > 1 && digits.startsWith("0")) continue;
      const grouped = /[,.]/.test(m[2]);
      // 円記号も桁区切りもない1〜2桁の数字は、個数・番号などの可能性が高く、金額とはみなさない
      if (!hasYenMark && !grouped && digits.length <= 2) continue;

      // 桁の読み取りが不確かな金額（一部だけを金額として読むと、誤った値になる）
      let suspect = false;
      let yen = Number(digits);
      // 桁区切りが空白・記号・文字に読まれて、数字が途中で切れている（「1 320」「1, 320」「1 4,720」「6'776」「2,?40」「1,32O」）
      const cont = !grouped && m[2].length <= 3 ? rest.match(/^(?:\s?[,.]\s?|\s{1,2})(\d{1,3}(?:[,.]\d{3})*|\d+)(?![\d:/])/) : null;
      if (cont) {
        suspect = true;
        yen = Number(m[2] + cont[1].replace(/[,.]/g, ""));
      } else if (
        // 数字のすぐ後ろに、金額の後ろには普通付かない文字（記号・英数字）が付いている
        (rest !== "" && !/^(?:\s|円|[)）\]】」』\-－―ー–—~〜*※＊\u3000-\u30ff\u4e00-\u9fff\uff00-\uffef/%、。:：;；,.])/.test(rest)) ||
        // 桁区切りの後ろに、日本語以外の文字が続いている
        /^[,.;:；：]\s?[^\s\u3000-\u30ff\u4e00-\u9fff\uff00-\uffef円]/.test(rest)
      ) {
        suspect = true;
        yen = 0;
      } else if (((prevChar === "," || prevChar === ".") && !/\d/.test(text[digitStart - 2] ?? "")) || /[|!'`´;_?]/.test(prevChar)) {
        // 桁区切りの前の数字が読めていない（「l,320」）、または数字の直前に、金額の前には普通付かない記号が付いている（「|4,720」）
        suspect = true;
        yen = 0;
      }
      if (!Number.isInteger(yen) || yen < 0 || yen > TOTAL_MAX_YEN || (!suspect && yen < 1)) {
        if (!suspect) continue;
        yen = 0;
      }

      // 金額の前に表記がなければ、直前の行（金額を含まない短い行）を表記として使う（「合計」と金額が別の行に読まれた場合）
      let effectiveLabel = label;
      if (effectiveLabel === "" && lineNo > 0) {
        const prev = lines[lineNo - 1];
        if (prev.text.length <= 20 && !/\d/.test(prev.text)) effectiveLabel = prev.text;
      }
      // 日本語の文字の間の空白（「合 計」「お 預 り」）は、表記の判定では無視する
      const labelForTest = compactCjkSpaces(effectiveLabel);

      let kind: AmountHit["kind"];
      if (EXCLUDE_LABEL.test(labelForTest)) continue;
      if (STRONG_LABEL.test(labelForTest)) kind = "strong";
      else if (!hasYenMark && !grouped) continue; // 円記号も桁区切りもない数字は、合計の表記がなければ金額とみなさない
      else kind = WEAK_LABEL.test(labelForTest) ? "weak" : "neutral";
      if (suspect && kind !== "strong") continue; // 合計の表記がない金額は、自動入力の対象にならないため、不確かなものは候補にもしない

      hits.push({ yen, lineIndex: line.index, kind, label: labelForTest, suspect });
    }
  });
  return hits;
}

function strongKeyword(label: string): string {
  return label.match(STRONG_LABEL)?.[0] ?? "合計";
}

export function extractTotal(lines: TextLine[]): FieldExtraction {
  return extractTotalFromPrepared(prepareLines(lines));
}

function extractTotalFromPrepared(prepared: PreparedLine[]): FieldExtraction {
  const hits = findAmounts(prepared);
  const strong = new Map<number, AmountHit>();
  for (const hit of hits.filter((h) => h.kind === "strong" && !h.suspect)) if (!strong.has(hit.yen)) strong.set(hit.yen, hit);
  const suspects = hits.filter((h) => h.kind === "strong" && h.suspect);
  // 「合計」などの表記があり、数字も含むのに、金額として読めなかった行（桁が文字に読まれた、など）。
  // 別の行の金額が1つだけ見つかっても、それが合計とは限らないため、自動では入れない。
  const unreadableStrongLine = prepared.some((line) => {
    const t = compactCjkSpaces(line.text);
    if (!STRONG_LABEL.test(t) || EXCLUDE_LABEL.test(t)) return false;
    const stripped = t
      .replace(/\d{4}\s*[年/.\-]\s*\d{1,2}\s*[月/.\-]\s*\d{1,2}\s*日?/g, "")
      .replace(/\d+\s*(?:年|月|日|時|分|秒|点|個|枚|品|名|人|回|本|台|%)/g, "")
      .replace(/\d{1,2}:\d{2}/g, "");
    return /\d/.test(stripped) && !hits.some((h) => h.lineIndex === line.index && h.kind === "strong");
  });

  const others = new Map<number, AmountHit>();
  for (const hit of hits.filter((h) => h.kind !== "strong" && !h.suspect)) if (!strong.has(hit.yen) && !others.has(hit.yen)) others.set(hit.yen, hit);
  const otherCandidates: FieldCandidate[] = [...others.values()]
    .sort((a, b) => b.yen - a.yen)
    .slice(0, 5)
    .map((h) => ({ value: String(h.yen), reason: `合計の表記がない金額（${h.yen.toLocaleString("ja-JP")}円）。合計かどうかは確認が必要です` }));

  const strongCandidates = (list: AmountHit[]): FieldCandidate[] =>
    list.map((h) => ({ value: String(h.yen), reason: `「${strongKeyword(h.label)}」の金額（${h.yen.toLocaleString("ja-JP")}円）` }));

  // 合計の表記がある行の金額の桁が、正しく読み取れていない可能性があるとき：自動では入れず、つなげて読んだ金額を候補にする
  if (suspects.length > 0 || unreadableStrongLine) {
    const joined = new Map<number, AmountHit>();
    for (const hit of suspects) if (hit.yen > 0 && !joined.has(hit.yen)) joined.set(hit.yen, hit);
    const suspectCandidates: FieldCandidate[] = [...joined.values()]
      .filter((h) => !strong.has(h.yen))
      .map((h) => ({ value: String(h.yen), reason: `「${strongKeyword(h.label)}」の金額ですが、桁が正しく読めていない可能性があります（${h.yen.toLocaleString("ja-JP")}円）` }));
    return {
      value: null,
      candidates: [...strongCandidates([...strong.values()]), ...suspectCandidates, ...otherCandidates],
      note: "合計の金額の桁が正しく読み取れていない可能性があるため、自動では入れていません。元の書類と見比べて、入力してください。",
      lowConfidence: false,
    };
  }
  if (strong.size === 1) {
    const hit = [...strong.values()][0];
    return {
      value: String(hit.yen),
      candidates: [...strongCandidates([hit]), ...otherCandidates],
      note: null,
      lowConfidence: isLowConfidence(prepared[hit.lineIndex]?.confidence ?? null),
    };
  }
  if (strong.size > 1) {
    return {
      value: null,
      candidates: [...strongCandidates([...strong.values()]), ...otherCandidates],
      note: "合計の候補が複数あります（税抜と税込、別の合計など）。どれが合計金額か確認して、選ぶか入力してください。",
      lowConfidence: false,
    };
  }
  if (otherCandidates.length > 0) {
    return {
      value: null,
      candidates: otherCandidates,
      note: "「合計」などの表記がある金額が見つからなかったため、金額は自動で入れていません。候補から選ぶか、入力してください。",
      lowConfidence: false,
    };
  }
  return emptyField("合計金額を見つけられませんでした。入力してください。");
}

// ---------------------------------------------------------------------------
// 取引先
// ---------------------------------------------------------------------------

/** 取引先として採用しない行（電話番号・住所・宛名・書類名・日付・金額・定型のあいさつなど） */
const NOT_VENDOR =
  /TEL|FAX|電話|℡|〒|領収|レシート|receipt|請求書|納品書|見積|伝票|明細|お買い?上げ?(?:明細|票|ありがとう)|ありがとう|またお越し|毎度|ご来店|レジ|担当|責任者|店番|登録番号|インボイス|適格|消費税|合計|小計|(?:様|御中|殿)$|^T\d{13}|https?:|www\.|@|\d{2,4}-\d{2,4}-\d{3,4}|\d{3}-\d{4}|[0-9一二三四五六七八九十]+丁目\s*\d|丁目\s*\d|番地|\d+-\d+-\d+|宛名|宛先|お客様|請求先|ご契約者|お名前|ご氏名|[都道府県].*[市区町村郡]|¥|\d,\d{3}|\d+円/i;
/** 店名・会社名らしい語 */
const VENDOR_HINT =
  /株式会社|有限会社|合同会社|\(株\)|\(有\)|\(同\)|商店|商事|薬局|ドラッグ|ストア|スーパー|マート|ショップ|百貨店|書店|文具|クリニック|医院|食堂|珈琲|コーヒー|カフェ|ホテル|旅館|レストラン|酒店|電気|工業|サービス|センター|事務所|支店|本店|店$|屋$|堂$|館$|社$/;
const VENDOR_LABEL = /^(?:発行元|発行者|請求元|請求者|販売元|店名|会社名|取引先|お店)\s*[:：]\s*(.+)$/;
const VENDOR_SCAN_LINES = 10;
const VENDOR_FALLBACK_SCAN_LINES = 5;

function cleanVendor(text: string): string {
  return text
    .replace(/^[\s*★☆※■□◆◇●○▼▲\-=_~〜、。.,:：;；|｜"'`]+/, "")
    .replace(/[\s*★☆※■□◆◇●○▼▲\-=_~〜、。.,:：;；|｜"'`]+$/, (tail, offset: number, whole: string) =>
      // 「Acme Inc.」「Foo Co., Ltd.」のように、会社の略称の最後のピリオドは残す
      /\.$/.test(tail) && /(?:Inc|Co|Ltd|Corp|LLC|Jr|Sr)$/i.test(whole.slice(0, offset)) ? "." : "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeDateOrTime(text: string): boolean {
  return /\d{1,4}\s*[/.\-年]\s*\d{1,2}\s*[/.\-月]/.test(text) || /\d{1,2}:\d{2}/.test(text);
}

function letterRatio(text: string): number {
  const letters = text.match(new RegExp(`[A-Za-z${CJK}]`, "g"))?.length ?? 0;
  const chars = text.replace(/\s/g, "").length;
  return chars === 0 ? 0 : letters / chars;
}

interface VendorHit {
  value: string;
  lineIndex: number;
  hinted: boolean;
  labeled: boolean;
}

function findVendors(prepared: PreparedLine[]): VendorHit[] {
  const hits: VendorHit[] = [];
  for (const line of prepared.slice(0, VENDOR_SCAN_LINES)) {
    const labelMatch = line.compact.match(VENDOR_LABEL);
    if (labelMatch) {
      const value = cleanVendor(labelMatch[1]);
      if (value.length >= 2 && value.length <= VENDOR_MAX_LENGTH && !NOT_VENDOR.test(value)) {
        hits.push({ value, lineIndex: line.index, hinted: true, labeled: true });
      }
      continue;
    }
    const value = cleanVendor(line.compact);
    if (value.length < 2 || value.length > 60) continue;
    if (NOT_VENDOR.test(value) || looksLikeDateOrTime(value)) continue;
    if (letterRatio(value) < 0.5) continue;
    hits.push({ value, lineIndex: line.index, hinted: VENDOR_HINT.test(value), labeled: false });
  }
  return hits;
}

export function extractVendor(lines: TextLine[]): FieldExtraction {
  return extractVendorFromPrepared(prepareLines(lines));
}

function extractVendorFromPrepared(prepared: PreparedLine[]): FieldExtraction {
  const hits = findVendors(prepared);
  const labeled = unique(hits.filter((h) => h.labeled));
  const hinted = unique(hits.filter((h) => h.hinted));
  const lowConf = (hit: VendorHit) => isLowConfidence(prepared[hit.lineIndex]?.confidence ?? null);

  if (labeled.length === 1) {
    return {
      value: labeled[0].value,
      candidates: [{ value: labeled[0].value, reason: "「発行元」などの表記がある行" }],
      note: null,
      lowConfidence: lowConf(labeled[0]),
    };
  }
  if (labeled.length === 0 && hinted.length === 1) {
    return {
      value: hinted[0].value,
      candidates: [{ value: hinted[0].value, reason: "書類の上部にある、店名・会社名らしい行" }],
      note: null,
      lowConfidence: lowConf(hinted[0]),
    };
  }
  if (hinted.length > 1) {
    return {
      value: null,
      candidates: hinted.slice(0, 5).map((h) => ({ value: h.value, reason: "書類の上部にある、店名・会社名らしい行" })),
      note: "取引先の候補が複数あります。取引先を選ぶか、入力してください。",
      lowConfidence: false,
    };
  }
  const fallback = unique(hits.filter((h) => h.lineIndex < VENDOR_FALLBACK_SCAN_LINES)).slice(0, 3);
  if (fallback.length > 0) {
    return {
      value: null,
      candidates: fallback.map((h) => ({ value: h.value, reason: "書類の上部にある文字（店名かどうかは確認が必要です）" })),
      note: "店名・会社名らしい行が見つからなかったため、取引先は自動で入れていません。",
      lowConfidence: false,
    };
  }
  return emptyField("取引先を見つけられませんでした。入力してください。");
}

function unique(hits: VendorHit[]): VendorHit[] {
  const seen = new Set<string>();
  const out: VendorHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.value)) continue;
    seen.add(hit.value);
    out.push(hit);
  }
  return out;
}

// ---------------------------------------------------------------------------
// まとめ
// ---------------------------------------------------------------------------

/** 1書類の文字の行から、日付・取引先・合計金額を抽出する */
export function extractReceipt(lines: TextLine[]): ReceiptExtraction {
  const prepared = prepareLines(lines);
  return {
    date: extractDateFromPrepared(prepared),
    vendor: extractVendorFromPrepared(prepared),
    total: extractTotalFromPrepared(prepared),
  };
}

/** 抽出できた項目の数（確定値が入った項目）。文字情報から取り出した結果とOCRの結果を比べるときに使う */
export function countFilledFields(extraction: ReceiptExtraction): number {
  return [extraction.date, extraction.vendor, extraction.total].filter((f) => f.value !== null).length;
}

/** 候補が1つでもあるか（日付・金額の候補が全く無い文字は、書類の内容ではない可能性がある） */
export function hasAnyCandidate(extraction: ReceiptExtraction): boolean {
  return extraction.date.candidates.length > 0 || extraction.total.candidates.length > 0;
}
