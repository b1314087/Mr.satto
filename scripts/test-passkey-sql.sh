#!/usr/bin/env bash
# パスキー・登録端末・同時利用のSQL（supabase/migrations/0011_passkeys_devices_sessions.sql）を、使い捨てのPostgreSQLで検証する。
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
"${PSQL[@]}" -f "$ROOT/supabase/migrations/0011_passkeys_devices_sessions.sql" >/dev/null 2>&1
# 2回目の適用（何度流しても安全）
"${PSQL[@]}" -f "$ROOT/supabase/migrations/0011_passkeys_devices_sessions.sql" >/dev/null 2>&1

"${PSQL[@]}" -f "$ROOT/supabase/tests/passkeys_devices_sessions_test.sql" | tee "$WORK/out.txt"
grep -q "PASSKEY SQL: ok" "$WORK/out.txt"

# 同時実行1: 同じユーザーが、空きのある状態から10台を同時に登録しても、2台までしか登録できない
U=00000000-0000-0000-0000-0000000000d4
"${PSQL[@]}" -c "insert into auth.users(id, email) values ('$U', 'race')" >/dev/null
for i in $(seq 1 10); do
  H=$(printf '%064x' "$i")
  ( "${PSQL[@]}" -c "set role service_role; select public.pk_register_device('$U', '$H', 'x', 2, 604800, 100)->>'outcome'" | grep -v '^SET' ) >> "$WORK/raceA.txt" &
done
wait
test "$(grep -c '^ok$' "$WORK/raceA.txt")" = "2" || { echo "race A: expected exactly 2 ok"; cat "$WORK/raceA.txt"; exit 1; }
test "$("${PSQL[@]}" -c "select count(*) from public.registered_devices where user_id='$U' and revoked_at is null")" = "2"

# 同時実行2: 2つの端末が、空いているロックを同時に10回ずつ取りにいっても、持ち主は常に1つ（取れるのは最初の1件だけ）
D1=$("${PSQL[@]}" -c "select id from public.registered_devices where user_id='$U' order by created_at limit 1")
D2=$("${PSQL[@]}" -c "select id from public.registered_devices where user_id='$U' order by created_at desc limit 1")
for i in $(seq 1 10); do
  ( "${PSQL[@]}" -c "set role service_role; select public.pk_acquire_lease('$U', '$D1', repeat('a', 64), 180, false)->>'outcome'" | grep -v '^SET' ) >> "$WORK/raceB.txt" &
  ( "${PSQL[@]}" -c "set role service_role; select public.pk_acquire_lease('$U', '$D2', repeat('b', 64), 180, false)->>'outcome'" | grep -v '^SET' ) >> "$WORK/raceB.txt" &
done
wait
OWNER=$("${PSQL[@]}" -c "select token_hash from public.paid_session_leases where user_id='$U'")
OK=$(grep -c '^ok$' "$WORK/raceB.txt")
INUSE=$(grep -c '^in_use$' "$WORK/raceB.txt")
test "$OK" = "10" && test "$INUSE" = "10" || { echo "race B: expected 10 ok (owner's retries) and 10 in_use"; cat "$WORK/raceB.txt"; exit 1; }
test "$("${PSQL[@]}" -c "select count(*) from public.paid_session_leases where user_id='$U'")" = "1"
echo "lease owner: ${OWNER:0:8}..."

# 取り消し用SQLで元に戻り、既存の表は残り、再適用できる
"${PSQL[@]}" -f "$ROOT/supabase/rollbacks/0011_passkeys_devices_sessions_rollback.sql" >/dev/null
test "$("${PSQL[@]}" -c "select count(*) from pg_proc where proname like 'pk\_%'")" = "0"
test "$("${PSQL[@]}" -c "select count(*) from pg_tables where tablename = 'subscriptions'")" = "1"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/0011_passkeys_devices_sessions.sql" >/dev/null 2>&1
test "$("${PSQL[@]}" -c "select count(*) from pg_proc where proname like 'pk\_%'")" = "13"
echo "ALL PASSKEY SQL TESTS PASSED"
