#!/usr/bin/env node
/**
 * 郵便番号・住所検索（総合改修 17）用の住所データを作る。
 *
 * 元データ：日本郵便「郵便番号データ（住所の郵便番号）」。日本郵便は、郵便番号データに限って著作権を主張せず、
 *          自由に配布してよいとしている。このスクリプトは、それを JSON に整えた yubinbango-data
 *          （https://github.com/yubinbango/yubinbango-data 、MIT の YubinBango プロジェクト）を読み込む。
 *
 * 使い方（データを新しくするとき。日本郵便のデータは毎月末ごろ更新）：
 *   git clone --depth 1 https://github.com/yubinbango/yubinbango-data /tmp/yubinbango-data
 *   node scripts/build-postal-data.mjs /tmp/yubinbango-data/data 2026-11-01
 *   （2つ目は元データの時点。yubinbango-data の最新の更新日を入れる。省略すると今日の日付）
 *
 * 出力：public/postal/
 *   - pref-01.json 〜 pref-47.json：都道府県ごとの [郵便番号, 市区町村, 町域] の一覧（住所 → 郵便番号の検索に使う）
 *   - index.json：郵便番号の上3桁 → 含まれる都道府県の番号（郵便番号 → 住所の検索で、読み込むファイルを決める）、作成日
 * どのファイルも、検索するときに、利用者のブラウザが自分のサイトから読み込むだけ（入力した住所・郵便番号は外部へ送らない）。
 */
import fs from "node:fs";
import path from "node:path";

const src = process.argv[2];
if (!src || !fs.existsSync(src)) {
  console.error("使い方: node scripts/build-postal-data.mjs <yubinbango-data の data フォルダ>");
  process.exit(1);
}
const outDir = path.join(process.cwd(), "public", "postal");
fs.mkdirSync(outDir, { recursive: true });

const byPref = new Map();
const index = {};
for (const name of fs.readdirSync(src).filter((f) => /^\d{3}\.js$/.test(f)).sort()) {
  const text = fs.readFileSync(path.join(src, name), "utf8");
  const json = JSON.parse(text.slice(text.indexOf("(") + 1, text.lastIndexOf(")")));
  const prefix = name.slice(0, 3);
  for (const [zip, v] of Object.entries(json)) {
    const pref = Number(v[0]);
    if (!(pref >= 1 && pref <= 47)) continue;
    if (!byPref.has(pref)) byPref.set(pref, []);
    byPref.get(pref).push([zip, v[1] ?? "", v[2] ?? ""]);
    index[prefix] ??= [];
    if (!index[prefix].includes(pref)) index[prefix].push(pref);
  }
}
let total = 0;
for (const [pref, rows] of byPref) {
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  total += rows.length;
  fs.writeFileSync(path.join(outDir, `pref-${String(pref).padStart(2, "0")}.json`), JSON.stringify(rows));
}
const updated = process.argv[3] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[3]) ? process.argv[3] : new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(outDir, "index.json"), JSON.stringify({ updated, source: "日本郵便 郵便番号データ（yubinbango-data 経由）", count: total, prefixes: index }));
console.log(`都道府県 ${byPref.size}・${total}件を書き出しました（${outDir}）`);
