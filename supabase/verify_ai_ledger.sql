-- AI利用枠の台帳（0003_ai_usage_ledger.sql）が本番に正しく適用されているかを確認する、読み取り専用のSQL。
-- Supabaseの SQL Editor に貼り付けて実行する。SELECTだけで、何も変更しない。
-- 期待する結果は、各ブロックのコメントに書いてある。

-- 1) テーブルと関数が存在し、RLSが有効か
--    期待: ai_usage_periods / ai_usage_requests の2行とも rls_enabled = true
select c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('ai_usage_periods', 'ai_usage_requests');

--    期待: ai_reserve / ai_settle / ai_release / ai_get_usage / ai_derive_period / ai_usage_json の6行
select p.proname as function_name, p.prosecdef as security_definer
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'ai\_%' escape '\'
order by 1;

-- 2) 利用者（anon / authenticated）が台帳のテーブルに触れる権限を持っていないか
--    期待: 0行（1行でもあれば、公開前に報告する）
select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('ai_usage_periods', 'ai_usage_requests')
  and grantee in ('anon', 'authenticated', 'PUBLIC');

-- 3) 利用者が台帳の関数を実行できないか
--    期待: ai_reserve / ai_settle / ai_release / ai_get_usage の4つとも、
--          anon_can_execute = false, authenticated_can_execute = false, service_role_can_execute = true
--          ai_derive_period / ai_usage_json は service_role_can_execute = false
select p.proname as function_name,
       has_function_privilege('anon', p.oid, 'execute') as anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute,
       has_function_privilege('service_role', p.oid, 'execute') as service_role_can_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'ai\_%' escape '\'
order by 1;

-- 4) 契約の表(subscriptions)に、利用者が書き込めるポリシーがないか
--    期待: subscriptions_select_own の1行（cmd = SELECT）だけ
select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'subscriptions';
