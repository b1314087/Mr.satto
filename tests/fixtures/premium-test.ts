import { test as base } from "@playwright/test";
import { setDevPlanOverride } from "../helpers/dev-plan";

/**
 * 代表ツールE2Eテスト用のPlaywright test拡張（Phase 14）。
 *
 * ほとんどのツールは requiredPlan: "standard" 以上であり、Freeプランの
 * ユーザーには汎用の <ToolAccessGate>（「広告を見て15分無料で使う」）が
 * 表示され、ツール本体（FileDropzone等）はレンダリングされない。
 *
 * ツールの入出力そのものを検証したいE2Eテストで、広告視聴フロー
 * （実際の広告SDKには接続していない）まで自動化するのは本質的ではないため、
 * Phase 11由来の開発専用Cookie（mrsatto-dev-plan-override、
 * NODE_ENV=development限定でのみ有効）を使い、全ツールにアクセスできる
 * "premium" プランとしてページへアクセスする。
 *
 * 本番ビルドではこの上書きは一切効かない（本体コード側のガード）ため、
 * この仕組みはテスト実行環境専用であり、本番の広告ゲート挙動自体を
 * 無効化するものではない。
 */
export const test = base.extend({
  // Playwrightのfixture拡張の慣例では第2引数を"use"と書くが、
  // eslint-plugin-react-hooks v7はReact 19の組み込みuse()フックと
  // 名前だけで誤認識してrules-of-hooksエラーを出すため、
  // ここでは意味の変わらない別名（runFixture）を使う。
  context: async ({ context, baseURL }, runFixture) => {
    await setDevPlanOverride(context, "premium", baseURL!);
    await runFixture(context);
  },
});

export { expect } from "@playwright/test";
