-- ─────────────────────────────────────────────────────────────────────────────
-- Buying credits is manual, so the app has to tell the user two things the
-- gateway could never infer: what the packages cost and who to pay.
--   * app_config.contact_*  — one set of administrator contact details, edited on
--     the panel's Contact tab, shown to every signed-in user.
--   * plans.blurb / includes — the packaging text the buyer sees next to the
--     price. plans.price_cents already existed but was never surfaced; it is
--     always USD, so the desktop renders it as a plain dollar amount.
-- Minutes still come only from grants — pricing here is display, not entitlement.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.app_config
  add column if not exists contact_message  text,
  add column if not exists contact_email    text,
  add column if not exists contact_phone    text,
  add column if not exists contact_whatsapp text;

alter table public.plans
  add column if not exists blurb    text,
  add column if not exists includes text[] not null default '{}',
  alter column currency set default 'usd';

update public.plans set currency = 'usd' where currency is distinct from 'usd';

-- The snapshot is the desktop's single round-trip for account state, so the
-- contact block travels with it rather than costing the app another query.
create or replace function public.sl_account_snapshot(p_user uuid default auth.uid())
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  if p_user is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  if auth.uid() is not null and auth.uid() <> p_user and not public.is_admin(auth.uid()) then
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
                                        'email',    c.contact_email,
                                        'phone',    c.contact_phone,
                                        'whatsapp', c.contact_whatsapp))
            from public.app_config c where c.id = 1)
  ) into v;
  return v;
end; $$;

grant execute on function public.sl_account_snapshot(uuid) to anon, authenticated;
