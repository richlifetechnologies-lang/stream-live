-- ─────────────────────────────────────────────────────────────────────────────
-- sl_account_snapshot is security definer and was granted to `anon`, and its
-- own guard only compared p_user when auth.uid() was non-null. So anyone holding
-- the public anon key could POST {"p_user":"<uuid>"} with no session at all and
-- read that account's balances, lifetime spend, bound devices and live call
-- leases. Verified against the running project: an anonymous call returned
-- ok:true. The function now demands a session, and anon loses execute entirely.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.sl_account_snapshot(p_user uuid default auth.uid())
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  -- No session, or a caller asking for someone else's account without being an
  -- admin, gets the same short answer. There is no anonymous view of a wallet.
  if p_user is null or auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'not signed in');
  end if;
  if auth.uid() <> p_user and not public.is_admin(auth.uid()) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  select jsonb_build_object(
    'ok', true,
    'user_id', p_user,
    'status', coalesce((select s.status::text from public.subscriptions s where s.user_id = p_user), 'none'),
    'plan_id', (select s.plan_id from public.subscriptions s where s.user_id = p_user),
    'modalities', jsonb_build_object(
      'video',       coalesce((select s.video_enabled       from public.subscriptions s where s.user_id = p_user), false),
      'audio',       coalesce((select s.audio_enabled       from public.subscriptions s where s.user_id = p_user), false),
      'video_audio', coalesce((select s.video_audio_enabled from public.subscriptions s where s.user_id = p_user), false)),
    'max_concurrent_sessions', coalesce((select s.max_concurrent_sessions from public.subscriptions s where s.user_id = p_user), 1),
    'wallets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'modality', b.modality::text, 'balance', b.balance, 'unlimited', b.unlimited,
        'total_credited', b.total_credited, 'total_spent', b.total_spent,
        'burn_rate', public.current_burn_rate(b.modality)))
      from public.credit_balances b where b.user_id = p_user), '[]'::jsonb),
    'open_sessions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', u.id, 'tab', u.tab, 'device_id', u.device_id, 'started_at', u.started_at,
        'lease_expires_at', u.lease_expires_at, 'real_minutes', u.real_minutes))
      from public.usage_sessions u
      where u.user_id = p_user and u.ended_at is null and u.lease_expires_at > now()), '[]'::jsonb),
    'devices', coalesce((
      select jsonb_agg(jsonb_build_object(
        'device_id', d.device_id, 'label', d.label, 'revoked', d.revoked, 'last_seen', d.last_seen))
      from public.devices d where d.user_id = p_user), '[]'::jsonb),
    'app', (select jsonb_build_object('min_supported_version', c.min_supported_version,
                                      'latest_version', c.latest_version,
                                      'maintenance', c.maintenance,
                                      'maintenance_message', c.maintenance_message,
                                      'contact', jsonb_build_object(
                                        'message',  c.contact_message,
                                        'whatsapp', c.contact_whatsapp,
                                        'telegram', c.contact_telegram),
                                      'pay', jsonb_build_object(
                                        'momo', c.pay_momo,
                                        'btc',  c.pay_btc))
            from public.app_config c where c.id = 1)
  ) into v;
  return v;
end; $$;

revoke execute on function public.sl_account_snapshot(uuid) from anon;
grant execute on function public.sl_account_snapshot(uuid) to authenticated;
