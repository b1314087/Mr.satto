#!/usr/bin/env bash
# supabase/manual/passkey_launch.sql（SQL Editorで1回で実行する用）を、0011から作り直す。
# 0011を直したら、これを実行してから、tests/passkey/passkey-policy.spec.ts を流す。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
{
  echo "-- ============================================================================"
  echo "-- Mr.Satto：パスキー機能を本番で使うための SQL（1回で実行できるようにまとめたもの）"
  echo "--   中身は supabase/migrations/0011_passkeys_devices_sessions.sql と同じ（メール認証の表・関数は含まない）。"
  echo "--   何度実行しても安全（すでに表がある場合は作り直さず、関数だけを最新にする）。既存の表・データは変更しない。"
  echo "--   Supabase → SQL Editor → New query に全文を貼り付けて Run。最後に「Success. No rows returned」と出れば成功。"
  echo "--   ★このファイルは自動テストで、0011の内容と一致することを確かめている（手で直さない）。"
  echo "-- ============================================================================"
  echo
  cat "$ROOT/supabase/migrations/0011_passkeys_devices_sessions.sql"
} > "$ROOT/supabase/manual/passkey_launch.sql"
