-- ============================================================================
-- Mr.Satto：パスキー用の表・関数が正しく作られたかを確かめる SQL（読み取りだけ。何も変更しない）
--   Supabase → SQL Editor → New query に全文を貼り付けて Run。
--   正常：19行（表が6行・関数が13行）出て、「正常」の列がすべて true。
--   passkey_launch.sql を実行する前に流すと、0行（まだ作られていない）。
--   「正常」の意味：表は、RLSが有効・ポリシーなし・ブラウザ（未ログイン/ログイン利用者）から直接読めず、サーバー（Service Role）は読み書きできる。
--                   関数は、ブラウザから実行できず、サーバー（Service Role）だけが実行できる。
-- ============================================================================
select '表' as "種類",
       c.relname as "名前",
       (c.relrowsecurity
        and (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) = 0
        and not has_table_privilege('anon', c.oid, 'select')
        and not has_table_privilege('authenticated', c.oid, 'select')
        and has_table_privilege('service_role', c.oid, 'select')
        and has_table_privilege('service_role', c.oid, 'insert')
        and has_table_privilege('service_role', c.oid, 'update')
        and has_table_privilege('service_role', c.oid, 'delete')) as "正常"
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relkind = 'r'
   and c.relname in ('passkey_credentials', 'registered_devices', 'passkey_challenges', 'passkey_verifications', 'paid_session_leases', 'auth_security_events')
union all
select '関数',
       p.proname,
       (not has_function_privilege('anon', p.oid, 'execute')
        and not has_function_privilege('authenticated', p.oid, 'execute')
        and has_function_privilege('service_role', p.oid, 'execute'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like 'pk\_%'
order by 1, 2;
