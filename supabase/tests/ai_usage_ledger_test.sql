-- AI利用台帳(0003_ai_usage_ledger.sql)の検証。scripts/test-ai-ledger-sql.sh が、使い捨てのPostgreSQLで実行する。
-- 失敗すると assert でエラーになり、スクリプトが失敗する。本番のSupabaseでは実行しない。
\set ON_ERROR_STOP 1

insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-000000000001', 'premium'),
  ('00000000-0000-0000-0000-000000000002', 'free'),
  ('00000000-0000-0000-0000-000000000003', 'pastdue'),
  ('00000000-0000-0000-0000-000000000004', 'noperiod'),
  ('00000000-0000-0000-0000-000000000005', 'lapse'),
  ('00000000-0000-0000-0000-000000000006', 'race'),
  ('00000000-0000-0000-0000-000000000007', 'race2'),
  ('00000000-0000-0000-0000-000000000008', 'shift'),
  ('00000000-0000-0000-0000-000000000009', 'other');
insert into public.subscriptions(user_id, plan, status, current_period_start, current_period_end)
select id, 'premium', 'active', now() - interval '10 days', now() + interval '20 days'
  from auth.users where email in ('premium', 'lapse', 'race', 'race2', 'shift', 'other');
insert into public.subscriptions(user_id, plan, status, current_period_start, current_period_end)
  values ('00000000-0000-0000-0000-000000000003', 'premium', 'past_due', now() - interval '10 days', now() + interval '20 days');
insert into public.subscriptions(user_id, plan, status) values ('00000000-0000-0000-0000-000000000004', 'premium', 'active');

set role service_role;

-- 予約・重複・確定・解放
do $$
declare r jsonb; u uuid := '00000000-0000-0000-0000-000000000001';
begin
  r := public.ai_reserve(u, '10000000-0000-0000-0000-000000000001', 'calendar-import', 'gpt-6-luna', 600, 1000);
  assert r->>'outcome' = 'ok' and (r->>'reserved_micro_usd')::int = 600, 'reserve ok';
  r := public.ai_reserve(u, '10000000-0000-0000-0000-000000000001', 'calendar-import', 'gpt-6-luna', 600, 1000);
  assert r->>'outcome' = 'duplicate' and (r->>'reserved_micro_usd')::int = 600, 'duplicate request is not counted twice';
  r := public.ai_reserve(u, '10000000-0000-0000-0000-000000000002', 'calendar-import', 'gpt-6-luna', 600, 1000);
  assert r->>'outcome' = 'quota_exceeded', 'over the limit is refused';
  r := public.ai_settle(u, '10000000-0000-0000-0000-000000000001', 450, 100, 0, 50);
  assert r->>'outcome' = 'ok' and (r->>'spent_micro_usd')::int = 450 and (r->>'reserved_micro_usd')::int = 0, 'settle';
  r := public.ai_settle(u, '10000000-0000-0000-0000-000000000001', 450);
  assert r->>'outcome' = 'already_settled' and (r->>'spent_micro_usd')::int = 450, 'settle is idempotent';
  r := public.ai_release(u, '10000000-0000-0000-0000-000000000001');
  assert r->>'outcome' = 'already_settled' and (r->>'spent_micro_usd')::int = 450, 'release cannot undo a settled request';
  r := public.ai_reserve(u, '10000000-0000-0000-0000-000000000003', 'calendar-import', 'gpt-6-luna', 400, 1000);
  assert r->>'outcome' = 'ok', 'reserve 400 (450+400 <= 1000)';
  r := public.ai_release(u, '10000000-0000-0000-0000-000000000003', 'openai_401');
  assert r->>'outcome' = 'ok' and (r->>'reserved_micro_usd')::int = 0 and (r->>'spent_micro_usd')::int = 450, 'release returns the reservation';
  r := public.ai_release(u, '10000000-0000-0000-0000-000000000003');
  assert r->>'outcome' = 'already_released' and (r->>'reserved_micro_usd')::int = 0, 'release is idempotent';
  r := public.ai_settle('00000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000003', 1);
  assert r->>'outcome' = 'not_found', 'another user cannot settle my request';
  r := public.ai_reserve('00000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000003', 'f', 'm', 1, 1000);
  assert r->>'outcome' = 'invalid', 'another user cannot reuse my request id';
  r := public.ai_reserve(u, '10000000-0000-0000-0000-000000000004', 'f', 'm', 0, 1000);
  assert r->>'outcome' = 'invalid', 'zero reservation is invalid';
end $$;

-- Premiumでない人
do $$
declare r jsonb;
begin
  r := public.ai_reserve('00000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'f', 'm', 1, 1000);
  assert r->>'outcome' = 'not_premium', 'free user';
  r := public.ai_reserve('00000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000002', 'f', 'm', 1, 1000);
  assert r->>'outcome' = 'not_premium', 'past_due user';
  r := public.ai_get_usage('00000000-0000-0000-0000-000000000002', 3000000);
  assert (r->>'entitled')::boolean = false and r->>'reason' = 'not_premium', 'get_usage for free user';
end $$;

-- 期間情報が無い契約（作成日から1か月で代用）・同時実行数・直近1分の回数
do $$
declare r jsonb; u uuid := '00000000-0000-0000-0000-000000000004';
begin
  r := public.ai_reserve(u, '30000000-0000-0000-0000-000000000001', 'f', 'm', 10, 1000, 1800, 2, 100);
  assert r->>'outcome' = 'ok', 'subscription without period data falls back';
  r := public.ai_reserve(u, '30000000-0000-0000-0000-000000000002', 'f', 'm', 10, 1000, 1800, 2, 100);
  assert r->>'outcome' = 'ok', 'second concurrent';
  r := public.ai_reserve(u, '30000000-0000-0000-0000-000000000003', 'f', 'm', 10, 1000, 1800, 2, 100);
  assert r->>'outcome' = 'too_many_concurrent', 'concurrency cap';
  r := public.ai_reserve(u, '30000000-0000-0000-0000-000000000004', 'f', 'm', 10, 1000, 1800, 100, 2);
  assert r->>'outcome' = 'rate_limited', 'per-minute cap';
end $$;

-- 期限切れ（課金有無が不明）は「使用済み」に計上し、確かな情報が来たら補正する
-- （now() は1トランザクション内で固定のため、待機の前後は別のトランザクション＝別のDOブロックにする）
do $$
declare r jsonb; u uuid := '00000000-0000-0000-0000-000000000005';
begin
  r := public.ai_reserve(u, '40000000-0000-0000-0000-000000000001', 'f', 'm', 300, 1000, 1, 3, 10);
  assert r->>'outcome' = 'ok', 'reserve with ttl 1s';
end $$;
select pg_sleep(2);
do $$
declare r jsonb; u uuid := '00000000-0000-0000-0000-000000000005';
begin
  r := public.ai_get_usage(u, 1000);
  assert (r->>'spent_micro_usd')::int = 300 and (r->>'reserved_micro_usd')::int = 0, 'expired reservation counts as spent in get_usage';
  r := public.ai_reserve(u, '40000000-0000-0000-0000-000000000002', 'f', 'm', 100, 1000, 1, 3, 10);
  assert r->>'outcome' = 'ok' and (r->>'spent_micro_usd')::int = 300 and (r->>'reserved_micro_usd')::int = 100, 'sweep moves expired reservation to spent';
end $$;
do $$
declare r jsonb; u uuid := '00000000-0000-0000-0000-000000000005';
begin
  r := public.ai_settle(u, '40000000-0000-0000-0000-000000000001', 120);
  assert (r->>'spent_micro_usd')::int = 120, 'late settle corrects spent (300 -> 120)';
  r := public.ai_settle(u, '40000000-0000-0000-0000-000000000001', 120);
  assert r->>'outcome' = 'already_settled' and (r->>'spent_micro_usd')::int = 120, 'late settle is idempotent';
end $$;
select pg_sleep(2);
do $$
declare r jsonb; u uuid := '00000000-0000-0000-0000-000000000005';
begin
  r := public.ai_reserve(u, '40000000-0000-0000-0000-000000000003', 'f', 'm', 10, 1000, 900, 3, 10);
  assert (r->>'spent_micro_usd')::int = 220, 'second expired reservation (100) counted: 120 + 100';
end $$;
do $$
declare r jsonb; u uuid := '00000000-0000-0000-0000-000000000005';
begin
  r := public.ai_release(u, '40000000-0000-0000-0000-000000000002');
  assert r->>'outcome' = 'ok' and (r->>'spent_micro_usd')::int = 120, 'late release of an expired reservation returns it';
  r := public.ai_settle(u, '40000000-0000-0000-0000-000000000003', 99);
  assert r->>'outcome' = 'ok_over_reservation' and (r->>'spent_micro_usd')::int = 219, 'actual above reservation is recorded as is';
end $$;

reset role;
select 'INVARIANT: ' || case when bool_and(ok) then 'ok' else 'BROKEN' end from (
  select p.reserved_micro_usd = coalesce(sum(r.reserved_micro_usd) filter (where r.status = 'reserved'), 0)
     and p.spent_micro_usd = coalesce(sum(r.actual_micro_usd) filter (where r.status = 'settled'), 0)
                           + coalesce(sum(r.reserved_micro_usd) filter (where r.status = 'lapsed'), 0) as ok
    from public.ai_usage_periods p left join public.ai_usage_requests r on r.period_id = p.id group by p.id) z;

-- 請求期間のずれ（使用量をリセットしない）・更新（新しい期間）
do $$
declare r jsonb; u uuid := '00000000-0000-0000-0000-000000000008'; n int;
begin
  perform set_config('role', 'service_role', true);
  r := public.ai_reserve(u, '50000000-0000-0000-0000-000000000001', 'f', 'm', 500, 99999);
  r := public.ai_settle(u, '50000000-0000-0000-0000-000000000001', 450);
  assert (r->>'limit_micro_usd')::int = 99999, 'limit is fixed at period creation';
end $$;
update public.subscriptions set current_period_start = current_period_start + interval '3 days', current_period_end = current_period_end + interval '3 days'
 where user_id = '00000000-0000-0000-0000-000000000008';
do $$
declare r jsonb; u uuid := '00000000-0000-0000-0000-000000000008'; n int;
begin
  perform set_config('role', 'service_role', true);
  r := public.ai_reserve(u, '50000000-0000-0000-0000-000000000002', 'f', 'm', 100, 12345);
  assert r->>'outcome' = 'ok' and (r->>'spent_micro_usd')::int = 450 and (r->>'limit_micro_usd')::int = 99999, 'shifted period start does not reset usage or change the limit';
  perform set_config('role', 'postgres', true);
  select count(*) into n from public.ai_usage_periods where user_id = u;
  assert n = 1, 'still one period after the shift';
end $$;
-- 次の請求期間（隣り合う）は新しい期間。前の期間の記録は残る
update public.ai_usage_periods set period_start = period_start - interval '40 days', period_end = period_end - interval '40 days'
 where user_id = '00000000-0000-0000-0000-000000000008';
update public.subscriptions set current_period_start = now() - interval '1 day', current_period_end = now() + interval '29 days'
 where user_id = '00000000-0000-0000-0000-000000000008';
do $$
declare r jsonb; u uuid := '00000000-0000-0000-0000-000000000008'; n int; old_spent bigint;
begin
  perform set_config('role', 'service_role', true);
  r := public.ai_reserve(u, '50000000-0000-0000-0000-000000000003', 'f', 'm', 100, 2000);
  assert r->>'outcome' = 'ok' and (r->>'spent_micro_usd')::int = 0 and (r->>'limit_micro_usd')::int = 2000, 'a new billing period starts fresh with the new limit';
  perform set_config('role', 'postgres', true);
  select count(*), max(spent_micro_usd) into n, old_spent from public.ai_usage_periods where user_id = u and spent_micro_usd > 0;
  assert n = 1 and old_spent = 450, 'previous period usage is preserved';
end $$;

-- 契約の終了日が過去（Webhookの遅延）なら、1か月ずつ進めた期間を使う
update public.subscriptions set current_period_start = now() - interval '35 days', current_period_end = now() - interval '5 days'
 where user_id = '00000000-0000-0000-0000-000000000007';
do $$
declare r jsonb;
begin
  perform set_config('role', 'service_role', true);
  r := public.ai_reserve('00000000-0000-0000-0000-000000000007', '60000000-0000-0000-0000-000000000001', 'f', 'm', 10, 1000);
  assert r->>'outcome' = 'ok' and (r->>'period_end')::timestamptz > now(), 'stale period end rolls forward';
end $$;

-- 権限: ブラウザ側（anon / authenticated）は、テーブルも関数も使えない
do $$
declare fn text; failed int := 0; role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    perform set_config('role', role_name, true);
    begin perform count(*) from public.ai_usage_periods; exception when insufficient_privilege then failed := failed + 1; end;
    begin perform count(*) from public.ai_usage_requests; exception when insufficient_privilege then failed := failed + 1; end;
    begin update public.ai_usage_periods set spent_micro_usd = 0; exception when insufficient_privilege then failed := failed + 1; end;
    begin insert into public.ai_usage_periods(user_id, period_start, period_end, limit_micro_usd) values ('00000000-0000-0000-0000-000000000001', now(), now() + interval '1 day', 1); exception when insufficient_privilege then failed := failed + 1; end;
    begin delete from public.ai_usage_requests; exception when insufficient_privilege then failed := failed + 1; end;
    begin perform public.ai_reserve('00000000-0000-0000-0000-000000000001', gen_random_uuid(), 'f', 'm', 1, 1000); exception when insufficient_privilege then failed := failed + 1; end;
    begin perform public.ai_settle('00000000-0000-0000-0000-000000000001', gen_random_uuid(), 1); exception when insufficient_privilege then failed := failed + 1; end;
    begin perform public.ai_release('00000000-0000-0000-0000-000000000001', gen_random_uuid()); exception when insufficient_privilege then failed := failed + 1; end;
    begin perform public.ai_get_usage('00000000-0000-0000-0000-000000000001', 1); exception when insufficient_privilege then failed := failed + 1; end;
    begin perform public.ai_derive_period('00000000-0000-0000-0000-000000000001'); exception when insufficient_privilege then failed := failed + 1; end;
    begin perform public.ai_usage_json(gen_random_uuid(), 'x', 'y'); exception when insufficient_privilege then failed := failed + 1; end;
  end loop;
  perform set_config('role', 'service_role', true);
  begin perform public.ai_derive_period('00000000-0000-0000-0000-000000000001'); exception when insufficient_privilege then failed := failed + 1; end;
  assert failed = 23, 'every browser-side access is denied (got ' || failed || ' of 23)';
end $$;

-- RLSが有効・関数はsearch_pathを固定
select 'RLS: ' || bool_and(relrowsecurity)::text from pg_class where relname in ('ai_usage_periods', 'ai_usage_requests');
do $$
begin
  assert (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'ai\_%' and p.prosecdef and p.proconfig @> array['search_path=""']) = 6, 'security definer functions pin search_path';
  assert not exists (select 1 from pg_policies where tablename in ('ai_usage_periods', 'ai_usage_requests')), 'no policies on ledger tables';
end $$;

-- 既存のデータ・権限に触れていない
do $$
begin
  assert (select count(*) from public.subscriptions where plan = 'premium') = 8, 'existing subscriptions are intact';
  assert exists (select 1 from pg_policies where tablename = 'subscriptions' and policyname = 'subscriptions_select_own'), 'existing RLS policy is intact';
end $$;
select 'SQL TESTS PASSED';
