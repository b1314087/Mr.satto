#!/usr/bin/env bash
# AI利用台帳のSQL（supabase/migrations/0003_ai_usage_ledger.sql）を、使い捨てのPostgreSQLで検証する。
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
$AS "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c max_connections=200" -l "$WORK/log" -w start >/dev/null
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
"${PSQL[@]}" -f "$ROOT/supabase/migrations/0003_ai_usage_ledger.sql" >/dev/null 2>&1
# 2回目の適用（何度流しても安全）
"${PSQL[@]}" -f "$ROOT/supabase/migrations/0003_ai_usage_ledger.sql" >/dev/null 2>&1

"${PSQL[@]}" -f "$ROOT/supabase/tests/ai_usage_ledger_test.sql" | tee "$WORK/out.txt"
grep -q "INVARIANT: ok" "$WORK/out.txt"
grep -q "RLS: true" "$WORK/out.txt"

# 同時実行: 同じユーザーが30件を同時に予約しても、上限(1,000,000)を超えない（100,000ずつ → ちょうど10件）
U=00000000-0000-0000-0000-000000000006
"${PSQL[@]}" -c "select 1" >/dev/null
for i in $(seq 1 30); do
  ( "${PSQL[@]}" -c "set role service_role; select public.ai_reserve('$U', gen_random_uuid(), 'f', 'm', 100000, 1000000, 1800, 100, 100)->>'outcome'" | grep -v '^SET' ) >> "$WORK/raceA.txt" &
done
wait
test "$(grep -c '^ok$' "$WORK/raceA.txt")" = "10" || { echo "race A: expected exactly 10 ok"; cat "$WORK/raceA.txt"; exit 1; }
test "$(grep -c '^quota_exceeded$' "$WORK/raceA.txt")" = "20" || { echo "race A: expected 20 quota_exceeded"; exit 1; }
test "$("${PSQL[@]}" -c "select reserved_micro_usd from public.ai_usage_periods where user_id='$U'")" = "1000000"

# 同じ依頼を20件同時に確定しても、1回しか計上しない
"${PSQL[@]}" -c "set role service_role; select public.ai_reserve('$U', '70000000-0000-0000-0000-000000000001', 'f', 'm', 1, 99999999, 1800, 1000, 1000)" >/dev/null 2>&1 || true
V=00000000-0000-0000-0000-000000000009
"${PSQL[@]}" -c "set role service_role; select public.ai_reserve('$V', '70000000-0000-0000-0000-000000000002', 'f', 'm', 5000, 100000, 1800, 100, 1000)" >/dev/null
for i in $(seq 1 20); do
  ( "${PSQL[@]}" -c "set role service_role; select public.ai_settle('$V', '70000000-0000-0000-0000-000000000002', 3000)->>'outcome'" | grep -v '^SET' ) >> "$WORK/raceB.txt" &
done
wait
test "$(grep -c '^ok$' "$WORK/raceB.txt")" = "1" || { echo "race B: expected exactly one ok"; cat "$WORK/raceB.txt"; exit 1; }
test "$("${PSQL[@]}" -c "select spent_micro_usd from public.ai_usage_periods where user_id='$V' order by period_start desc limit 1")" = "3000"

# 取り消し用SQLで元に戻り、再適用できる
"${PSQL[@]}" -f "$ROOT/supabase/rollbacks/0003_ai_usage_ledger_rollback.sql" >/dev/null 2>&1
test "$("${PSQL[@]}" -c "select count(*) from pg_proc where proname like 'ai\_%'")" = "0"
test "$("${PSQL[@]}" -c "select count(*) from public.subscriptions")" -ge 1
"${PSQL[@]}" -f "$ROOT/supabase/migrations/0003_ai_usage_ledger.sql" >/dev/null 2>&1
test "$("${PSQL[@]}" -c "select count(*) from pg_proc where proname like 'ai\_%'")" = "6"
echo "ALL SQL TESTS PASSED"
