-- 0012_passkey_email_verification.sql の検証（scripts/test-passkey-sql.sh が使い捨てのPostgreSQLで実行する）
\set ON_ERROR_STOP 1
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'erin'),
  ('00000000-0000-0000-0000-0000000000f2', 'frank');
set role service_role;

do $$
declare u uuid := '00000000-0000-0000-0000-0000000000e1'; v text := repeat('a', 64); r jsonb; id1 uuid; i int;
begin
  -- 送信：1通目はよい。60秒以内の送り直しは断る
  r := public.pk_email_begin_send(u, v, 600, 60, 5);
  assert r->>'outcome' = 'ok', 'first send';
  id1 := (r->>'id')::uuid;
  r := public.pk_email_begin_send(u, v, 600, 60, 5);
  assert r->>'outcome' = 'too_soon' and (r->>'retry_after_sec')::int between 1 and 60, 'resend interval';

  -- 試す：5回まで。6回目は止める（コードが正しくても）
  for i in 1..5 loop
    r := public.pk_email_attempt(u, v, 5);
    assert r->>'outcome' = 'ok' and (r->>'remaining')::int = 5 - i, 'attempt ' || i;
  end loop;
  r := public.pk_email_attempt(u, v, 5);
  assert r->>'outcome' = 'locked', 'locked after 5 attempts';
  assert not public.pk_email_has_approval(u, v, 600), 'no approval without verification';

  -- 送り直す（間隔を過ぎたことにする）→ 前のコードは無効になり、新しいコードで試せる
  update public.passkey_email_challenges set sent_at = sent_at - interval '61 seconds' where user_id = u;
  r := public.pk_email_begin_send(u, v, 600, 60, 5);
  assert r->>'outcome' = 'ok', 'resend after interval';
  assert (select count(*) from public.passkey_email_challenges where user_id = u and expires_at > now()) = 1, 'old code invalidated';
  r := public.pk_email_attempt(u, v, 5);
  assert r->>'outcome' = 'ok', 'attempt on new code';
  assert public.pk_email_mark_verified(u, (r->>'id')::uuid), 'verified';
  assert not public.pk_email_mark_verified(u, (r->>'id')::uuid), 'verify only once';

  -- 確認済みは、同じ本人確認の値でだけ、1回だけ使える
  assert not public.pk_email_consume_approval(u, repeat('b', 64), 600), 'bound to the passkey verification';
  assert not public.pk_email_consume_approval('00000000-0000-0000-0000-0000000000f2', v, 600), 'bound to the user';
  assert public.pk_email_has_approval(u, v, 600), 'approval exists';
  assert public.pk_email_consume_approval(u, v, 600), 'consume once';
  assert not public.pk_email_consume_approval(u, v, 600), 'cannot reuse';

  -- 有効期限切れのコードは試せない
  update public.passkey_email_challenges set sent_at = sent_at - interval '61 seconds' where user_id = u;
  r := public.pk_email_begin_send(u, v, 600, 60, 5);
  update public.passkey_email_challenges set expires_at = now() - interval '1 second' where id = (r->>'id')::uuid;
  r := public.pk_email_attempt(u, v, 5);
  assert r->>'outcome' = 'expired', 'expired code';

  -- 確認から時間がたった承認は使えない
  update public.passkey_email_challenges set sent_at = sent_at - interval '61 seconds' where user_id = u;
  r := public.pk_email_begin_send(u, v, 600, 60, 5);
  perform public.pk_email_attempt(u, v, 5);
  perform public.pk_email_mark_verified(u, (r->>'id')::uuid);
  update public.passkey_email_challenges set verified_at = now() - interval '11 minutes' where id = (r->>'id')::uuid;
  assert not public.pk_email_consume_approval(u, v, 600), 'stale approval';
end;
$$;

-- 1時間に5通まで（送信に失敗して取り消した分は数えない）
do $$
declare u uuid := '00000000-0000-0000-0000-0000000000f2'; v text := repeat('c', 64); r jsonb; i int;
begin
  for i in 1..5 loop
    r := public.pk_email_begin_send(u, v, 600, 0, 5);
    assert r->>'outcome' = 'ok', 'send ' || i;
  end loop;
  r := public.pk_email_begin_send(u, v, 600, 0, 5);
  assert r->>'outcome' = 'hourly_limit', 'hourly limit';
  -- 失敗した送信の取り消し
  delete from public.passkey_email_challenges where user_id = u;
  r := public.pk_email_begin_send(u, v, 600, 0, 5);
  perform public.pk_email_cancel_send(u, (r->>'id')::uuid);
  assert (select count(*) from public.passkey_email_challenges where user_id = u) = 0, 'cancelled send is not counted';
  -- 端末の登録の履歴（解除した端末も数える）
  assert public.pk_device_history_count(u) = 0, 'no devices yet';
  perform public.pk_register_device(u, repeat('d', 64), 'x');
  assert public.pk_device_history_count(u) = 1, 'one device';
end;
$$;
reset role;

do $$
begin
  assert (select relrowsecurity from pg_class where oid = 'public.passkey_email_challenges'::regclass), 'RLS enabled';
  assert not has_table_privilege('authenticated', 'public.passkey_email_challenges', 'select'), 'authenticated cannot read';
  assert not has_table_privilege('anon', 'public.passkey_email_challenges', 'select'), 'anon cannot read';
  assert not has_function_privilege('authenticated', 'public.pk_email_begin_send(uuid, text, int, int, int)', 'execute'), 'authenticated cannot send';
  assert not has_function_privilege('authenticated', 'public.pk_email_consume_approval(uuid, text, int)', 'execute'), 'authenticated cannot consume';
end;
$$;
select 'PASSKEY EMAIL SQL: ok';
