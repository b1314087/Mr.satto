#!/usr/bin/env bash
# ツール利用回数のSQL（supabase/migrations/0005_tool_usage_validation.sql）を、使い捨てのPostgreSQLで検証する。
# 本番のSupabaseには一切接続しない。PostgreSQLが無い環境では、終了コード77（スキップ）で終わる。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
if [ -z "$PGBIN" ] || [ ! -x "$PGBIN/initdb" ]; then echo "PostgreSQL not found; skipping"; exit 77; fi

WORK="$(mktemp -d)"
PORT=$((20000 + RANDOM % 20000))
AS=""
if [ "$(id -u)" = "0" ]; then
  chown postgres "$WORK" 2>/dev/null || { echo "cannot prepare a non-root user; skipping"; exit 77; }
  AS="runuser -u postgres --"
fi
cleanup() { $AS "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

$AS "$PGBIN/initdb" -D "$WORK/data" -A trust >/dev/null
$AS "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK" -l "$WORK/log" -w start >/dev/null
PSQL=(psql -h "$WORK" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q -A -t)
"${PSQL[@]}" -c "create database t" >/dev/null
PSQL+=(-d t)

# Supabaseに相当する最小のスタブ（ロール・auth.users・既定の権限）
"${PSQL[@]}" >/dev/null <<'SQL'
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
SQL

"${PSQL[@]}" -f "$ROOT/supabase/migrations/0001_billing_schema.sql" >/dev/null 2>&1
"${PSQL[@]}" -f "$ROOT/supabase/migrations/0002_tool_usage_daily.sql" >/dev/null 2>&1
"${PSQL[@]}" -f "$ROOT/supabase/migrations/0005_tool_usage_validation.sql" >/dev/null 2>&1
# 2回目の適用（何度流しても安全）
"${PSQL[@]}" -f "$ROOT/supabase/migrations/0005_tool_usage_validation.sql" >/dev/null 2>&1

"${PSQL[@]}" -c "insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'a@example.com'), ('00000000-0000-0000-0000-000000000002', 'b@example.com')" >/dev/null

"${PSQL[@]}" <<'SQL' 2>&1 | tee "$WORK/out.txt"
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);

-- 正常な識別子: 1, 2 と加算される
select 'valid1:' || public.increment_tool_usage('image-resize');
select 'valid2:' || public.increment_tool_usage('image-resize');
-- 64文字は許可（先頭が英数字で、残り63文字）
select 'valid64:' || public.increment_tool_usage('a' || repeat('b', 63));

-- 不正な識別子は、すべて 22023 で拒否される
do $$
declare v text; bad text[] := array['', ' ', 'Image-Resize', 'image resize', '-image', 'image_resize', 'a;drop table x', '画像', repeat('a', 65), 'a' || chr(10), E'a\nb', 'a/b', '../x'];
begin
  foreach v in array bad loop
    begin
      perform public.increment_tool_usage(v);
      raise notice 'NOT-REJECTED: %', v;
    exception when sqlstate '22023' then
      null;
    end;
  end loop;
  begin
    perform public.increment_tool_usage(null);
    raise notice 'NOT-REJECTED: null';
  exception when sqlstate '22023' then null;
  end;
  raise notice 'REJECTED-ALL';
end $$;

-- 不正な識別子で、行が作られていない
select 'rows:' || count(*) from public.tool_usage_daily;

-- 安全弁: 999 の状態から 1000 になり、その後は増えない
reset role;
update public.tool_usage_daily set count = 999 where tool_id = 'image-resize';
set role authenticated;
select 'cap1:' || public.increment_tool_usage('image-resize');
select 'cap2:' || public.increment_tool_usage('image-resize');
select 'cap3:' || public.increment_tool_usage('image-resize');

-- 他のユーザーの回数には影響しない
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', false);
select 'other:' || public.increment_tool_usage('image-resize');

-- 未ログイン（auth.uid() が NULL）は拒否される
select set_config('request.jwt.claim.sub', '', false);
do $$
begin
  perform public.increment_tool_usage('image-resize');
  raise notice 'NOT-REJECTED: unauthenticated';
exception when others then
  raise notice 'UNAUTH-REJECTED: %', sqlerrm;
end $$;

-- ログイン済みでも、テーブルへ直接書き込めない
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
do $$
begin
  insert into public.tool_usage_daily (user_id, tool_id, usage_date, count) values (auth.uid(), 'x', current_date, 1);
  raise notice 'NOT-REJECTED: direct insert';
exception when others then
  raise notice 'DIRECT-INSERT-REJECTED';
end $$;

-- anon は関数を実行できない
reset role;
set role anon;
do $$
begin
  perform public.increment_tool_usage('image-resize');
  raise notice 'NOT-REJECTED: anon';
exception when insufficient_privilege then
  raise notice 'ANON-REJECTED';
end $$;
reset role;
SQL

check() { grep -q "$1" "$WORK/out.txt" || { echo "FAILED: expected '$1'"; exit 1; }; }
check "valid1:1"
check "valid2:2"
check "valid64:1"
check "REJECTED-ALL"
if grep -q "NOT-REJECTED" "$WORK/out.txt"; then echo "FAILED: something was not rejected"; exit 1; fi
check "rows:2"
check "cap1:1000"
check "cap2:1000"
check "cap3:1000"
check "other:1"
check "UNAUTH-REJECTED: authentication required"
check "DIRECT-INSERT-REJECTED"
check "ANON-REJECTED"
echo "ALL SQL TESTS PASSED"
