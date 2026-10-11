-- ─────────────────────────────────────────────────────────────────────────────
-- Buying credits is manual, so the catalogue a user reads has to answer three
-- questions at once: what is the package, what does it contain, and where do I
-- pay it.
--   * plans.<modality>_minutes — the minutes attached to a package per modality,
--     so a buyer sees "300 Video Call minutes" before paying rather than asking.
--   * app_config.pay_momo / pay_btc — the only two payment methods accepted.
--   * app_config.contact_telegram, with WhatsApp — the only two contact centres.
--     Email and phone were never used and are dropped.
-- None of this moves money: minutes still land only through admin grants, and
-- the panel uses these plan figures as the amounts it offers to credit.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.plans
  add column if not exists video_minutes        integer not null default 0,
  add column if not exists audio_minutes        integer not null default 0,
  add column if not exists video_audio_minutes  integer not null default 0;

alter table public.app_config
  add column if not exists contact_telegram text,
  add column if not exists pay_momo         text,
  add column if not exists pay_btc          text,
  drop column if exists contact_email,
  drop column if exists contact_phone;

-- The three amounts start at zero on purpose: legacy plans.monthly_minutes was a
-- single allowance under a retired model, and guessing a split from it would put
-- numbers in front of buyers that nobody agreed to. The administrator types the
-- real amounts on the panel's Plans tab.

-- The snapshot is the desktop's single round-trip for account state, so the
-- payment and contact blocks travel with it rather than costing another query.
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
                                        'whatsapp', c.contact_whatsapp,
                                        'telegram', c.contact_telegram),
                                      'pay', jsonb_build_object(
                                        'momo', c.pay_momo,
                                        'btc',  c.pay_btc))
            from public.app_config c where c.id = 1)
  ) into v;
  return v;
end; $$;

grant execute on function public.sl_account_snapshot(uuid) to anon, authenticated;
