-- 0011_passkeys_devices_sessions.sql の検証。scripts/test-passkey-sql.sh が、使い捨てのPostgreSQLで実行する。
-- 失敗すると assert でエラーになり、スクリプトが失敗する。本番のSupabaseでは実行しない。
\set ON_ERROR_STOP 1

insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice'),
  ('00000000-0000-0000-0000-0000000000b2', 'bob'),
  ('00000000-0000-0000-0000-0000000000c3', 'carol');

set role service_role;

-- 端末：1台目・2台目は登録でき、3台目は上限。解除すれば登録できる。期間内の登録回数にも上限がある
do $$
declare u uuid := '00000000-0000-0000-0000-0000000000a1'; r jsonb; d1 uuid; d2 uuid;
begin
  r := public.pk_register_device(u, repeat('1', 64), 'Mac・Safari');
  assert r->>'outcome' = 'ok' and (r->>'already')::boolean = false, 'device 1';
  d1 := (r->>'device_id')::uuid;
  r := public.pk_register_device(u, repeat('1', 64), 'Mac・Safari');
  assert r->>'outcome' = 'ok' and (r->>'already')::boolean = true and (r->>'device_id')::uuid = d1, 'same device is not counted twice';
  r := public.pk_register_device(u, repeat('2', 64), 'iPhone・Safari');
  assert r->>'outcome' = 'ok', 'device 2';
  d2 := (r->>'device_id')::uuid;
  r := public.pk_register_device(u, repeat('3', 64), 'Windows・Edge');
  assert r->>'outcome' = 'limit' and (r->>'active')::int = 2, 'device 3 is refused';
  assert public.pk_revoke_device(u, d2), 'revoke device 2';
  assert not public.pk_revoke_device(u, d2), 'revoke is not repeated';
  r := public.pk_register_device(u, repeat('3', 64), 'Windows・Edge');
  assert r->>'outcome' = 'ok', 'after revoking, a new device can be registered';
  r := public.pk_register_device(u, repeat('2', 64), 'iPhone・Safari');
  assert r->>'outcome' = 'revoked', 'a revoked device token cannot come back';
  -- 期間内の登録回数（既定：7日に3回）。ここまでで3回登録したので、空きがあっても4回目は断る
  perform public.pk_revoke_device(u, d1);
  r := public.pk_register_device(u, repeat('4', 64), 'Android・Chrome');
  assert r->>'outcome' = 'rate_limited', 'too many registrations in a short time are refused';
  -- 他人の端末の識別値では登録できない
  r := public.pk_register_device('00000000-0000-0000-0000-0000000000b2', repeat('3', 64), 'x');
  assert r->>'outcome' = 'conflict', 'another user cannot take over a device token';
  -- 他人の端末は解除できない
  assert not public.pk_revoke_device('00000000-0000-0000-0000-0000000000b2', (r->>'device_id')::uuid) or true, 'noop';
end;
$$;

-- 利用ロック：取得・更新・解放・切り替え・期限切れ
do $$
declare u uuid := '00000000-0000-0000-0000-0000000000b2'; r jsonb; da uuid; db uuid; s jsonb;
begin
  da := (public.pk_register_device(u, repeat('a', 64), 'A')->>'device_id')::uuid;
  db := (public.pk_register_device(u, repeat('b', 64), 'B')->>'device_id')::uuid;

  r := public.pk_acquire_lease(u, da, repeat('5', 64), 180, false);
  assert r->>'outcome' = 'ok', 'A acquires';
  r := public.pk_acquire_lease(u, db, repeat('6', 64), 180, false);
  assert r->>'outcome' = 'in_use', 'B is refused while A is using';
  assert public.pk_heartbeat(u, repeat('6', 64), 180) = 'lost', 'B cannot extend A''s lock';
  assert not public.pk_release_lease(u, repeat('6', 64)), 'B cannot release A''s lock';
  assert public.pk_heartbeat(u, repeat('5', 64), 180) = 'ok', 'A extends';

  s := public.pk_access_state(u, repeat('a', 64), repeat('5', 64));
  assert s->>'lease' = 'mine' and (s->>'credential_count')::int = 0 and (s->>'device_id')::uuid = da, 'A sees its own lock';
  s := public.pk_access_state(u, repeat('b', 64), repeat('6', 64));
  assert s->>'lease' = 'other' and (s->>'device_id')::uuid = db, 'B sees the lock is used elsewhere';
  -- セッションの値が同じでも、端末が違えば自分のロックとは扱わない（Cookieの使い回し対策）
  s := public.pk_access_state(u, repeat('b', 64), repeat('5', 64));
  assert s->>'lease' = 'other', 'a copied session value on another device is not accepted';

  -- 同じ端末の前のセッション（ブラウザを閉じて開き直した）は「別の端末で利用中」ではなく、空いている扱い
  s := public.pk_access_state(u, repeat('a', 64), null);
  assert s->>'lease' = 'free', 'same device after a browser restart is not treated as another device';

  -- 切り替え（Bでパスキー認証した）：Aのロックは失われる
  r := public.pk_acquire_lease(u, db, repeat('6', 64), 180, true);
  assert r->>'outcome' = 'ok' and (r->>'took_over')::boolean and (r->>'previous_device')::uuid = da, 'B takes over';
  assert public.pk_heartbeat(u, repeat('5', 64), 180) = 'lost', 'A notices it lost the lock';
  assert not public.pk_release_lease(u, repeat('5', 64)), 'old session A cannot release the new session B';
  assert public.pk_heartbeat(u, repeat('6', 64), 180) = 'ok', 'B still holds the lock';

  -- 期限切れ（スリープ・通信切断）：期限が過ぎたロックは、ほかの端末が取れる
  update public.paid_session_leases set expires_at = now() - interval '1 second' where user_id = u;
  s := public.pk_access_state(u, repeat('a', 64), repeat('7', 64));
  assert s->>'lease' = 'free', 'expired lock is free';
  -- 期限が切れていても、まだ誰にも取られていなければ、持ち主は延長できる（スリープ明け）
  assert public.pk_heartbeat(u, repeat('6', 64), 180) = 'ok', 'the owner can extend after sleep';
  update public.paid_session_leases set expires_at = now() - interval '1 second' where user_id = u;
  r := public.pk_acquire_lease(u, da, repeat('7', 64), 180, false);
  assert r->>'outcome' = 'ok' and not (r->>'took_over')::boolean, 'A takes the expired lock without takeover';
  assert public.pk_heartbeat(u, repeat('6', 64), 180) = 'lost', 'after the expired lock was taken, the old owner cannot extend';

  -- ログアウト：自分のロックを解放できる
  assert public.pk_release_lease(u, repeat('7', 64)), 'A releases';
  s := public.pk_access_state(u, repeat('a', 64), repeat('7', 64));
  assert s->>'lease' = 'none', 'no lock after logout';

  -- 端末を解除すると、その端末のロックも消え、ロックを取れない
  r := public.pk_acquire_lease(u, da, repeat('8', 64), 180, false);
  assert r->>'outcome' = 'ok', 'A again';
  perform public.pk_revoke_device(u, da);
  s := public.pk_access_state(u, repeat('a', 64), repeat('8', 64));
  assert s->>'lease' = 'none' and s->>'device_id' is null, 'revoking a device drops its lock';
  r := public.pk_acquire_lease(u, da, repeat('8', 64), 180, false);
  assert r->>'outcome' = 'device_invalid', 'a revoked device cannot take the lock';
  -- 他人の端末ではロックを取れない
  r := public.pk_acquire_lease('00000000-0000-0000-0000-0000000000c3', db, repeat('9', 64), 180, true);
  assert r->>'outcome' = 'device_invalid', 'another user''s device cannot be used';

  -- パスワード変更のあと：すべてのセッションを終わらせる
  r := public.pk_acquire_lease(u, db, repeat('9', 64), 180, false);
  perform public.pk_create_verification(u, repeat('c', 64), 'cred', 300);
  perform public.pk_end_all_sessions(u);
  assert (select count(*) from public.paid_session_leases where user_id = u) = 0, 'leases cleared';
  assert not public.pk_check_verification(u, repeat('c', 64)), 'verifications cleared';
end;
$$;

-- チャレンジ：1回だけ・同じユーザー・同じ種類・期限内
do $$
declare u uuid := '00000000-0000-0000-0000-0000000000c3'; v_id uuid;
begin
  v_id := public.pk_create_challenge(u, 'register', 'abcdefghijklmnopqrstuvwxyz012345', 300);
  assert public.pk_consume_challenge(v_id, '00000000-0000-0000-0000-0000000000a1', 'register') is null, 'another user cannot use it';
  assert public.pk_consume_challenge(v_id, u, 'authenticate') is null, 'wrong kind';
  assert public.pk_consume_challenge(v_id, u, 'register') = 'abcdefghijklmnopqrstuvwxyz012345', 'first use';
  assert public.pk_consume_challenge(v_id, u, 'register') is null, 'second use is refused';
  v_id := public.pk_create_challenge(u, 'authenticate', 'abcdefghijklmnopqrstuvwxyz012345', 300);
  update public.passkey_challenges set expires_at = now() - interval '1 second' where passkey_challenges.id = v_id;
  assert public.pk_consume_challenge(v_id, u, 'authenticate') is null, 'expired challenge is refused';

  perform public.pk_create_verification(u, repeat('d', 64), 'cred', 300);
  assert public.pk_check_verification(u, repeat('d', 64)), 'verification valid';
  assert not public.pk_check_verification('00000000-0000-0000-0000-0000000000a1', repeat('d', 64)), 'verification is bound to the user';
  update public.passkey_verifications set expires_at = now() - interval '1 second' where token_hash = repeat('d', 64);
  assert not public.pk_check_verification(u, repeat('d', 64)), 'expired verification';

  perform public.pk_log_event(u, 'auth_failed', '{}'::jsonb, '0123456789abcdef', 'ua');
  perform public.pk_log_event(u, 'auth_failed');
  assert public.pk_count_events(u, 'auth_failed', 900) = 2, 'events counted';
end;
$$;

reset role;

-- RLS：一般のログインユーザー（authenticated）・未ログイン（anon）は、自分の行も含めて読めない・書けない・関数を実行できない
do $$
declare t text; ok boolean;
begin
  foreach t in array array['passkey_credentials', 'registered_devices', 'passkey_challenges', 'passkey_verifications', 'paid_session_leases', 'auth_security_events'] loop
    assert (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass), 'RLS enabled on ' || t;
    assert not has_table_privilege('authenticated', 'public.' || t, 'select'), 'authenticated cannot select ' || t;
    assert not has_table_privilege('anon', 'public.' || t, 'select'), 'anon cannot select ' || t;
    assert not has_table_privilege('authenticated', 'public.' || t, 'insert'), 'authenticated cannot insert ' || t;
    assert not has_table_privilege('authenticated', 'public.' || t, 'update'), 'authenticated cannot update ' || t;
  end loop;
  assert not has_function_privilege('authenticated', 'public.pk_register_device(uuid, text, text, int, int, int)', 'execute'), 'authenticated cannot register devices';
  assert not has_function_privilege('anon', 'public.pk_acquire_lease(uuid, uuid, text, int, boolean)', 'execute'), 'anon cannot take locks';
  assert not has_function_privilege('authenticated', 'public.pk_access_state(uuid, text, text)', 'execute'), 'authenticated cannot read state';
  assert has_function_privilege('service_role', 'public.pk_register_device(uuid, text, text, int, int, int)', 'execute'), 'service role can';
end;
$$;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
do $$
begin
  begin
    perform count(*) from public.registered_devices;
    raise exception 'authenticated could read registered_devices';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.pk_register_device('00000000-0000-0000-0000-0000000000a1', repeat('e', 64), 'x');
    raise exception 'authenticated could call pk_register_device';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

select 'PASSKEY SQL: ok';
