-- 0003_ai_usage_ledger.sql の取り消し（ロールバック）用SQL【草案・未適用】
--
-- 注意:
--   - 台帳（ai_usage_periods / ai_usage_requests）の記録はすべて消えます。適用後に実際の利用記録が
--     溜まっている場合は、先に必要ならエクスポートしてください。
--   - subscriptions の追加列は、Webhook改修（工程4B実装）後は値が入っています。列を消すと
--     current_period_start / stripe_price_id の同期値も失われます（Stripeから再同期は可能）。
--     列は残しても無害なので、通常は「5. 列の削除」を実行せず残す運用を推奨します。
--   - 既存の契約・プラン・tool_usage_daily 等には一切触れません。

begin;

-- 1. 関数
drop function if exists public.ai_get_usage(uuid, bigint);
drop function if exists public.ai_release(uuid, uuid, text);
drop function if exists public.ai_settle(uuid, uuid, bigint, integer, integer, integer);
drop function if exists public.ai_reserve(uuid, uuid, text, text, bigint, bigint, integer, integer, integer, text);
drop function if exists public.ai_usage_json(uuid, text, text);
drop function if exists public.ai_derive_period(uuid);

-- 2. テーブル（requests が periods を参照するため requests から先に）
drop table if exists public.ai_usage_requests;
drop table if exists public.ai_usage_periods;

commit;

-- 5. 列の削除（commit後に単独で実行すること）（通常は実行しない。上記の注意を参照）
-- alter table public.subscriptions drop column if exists current_period_start;
-- alter table public.subscriptions drop column if exists stripe_price_id;
-- alter table public.subscriptions drop column if exists stripe_synced_at;
