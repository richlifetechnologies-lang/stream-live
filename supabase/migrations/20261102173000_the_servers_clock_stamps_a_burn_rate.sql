-- 20261102173000_the_servers_clock_stamps_a_burn_rate.sql
--
-- Why this exists, in one line: the administrator saved a video rate of 1.25x, and every call after
-- that still drained the pool at 1x.
--
-- The panel wrote the row itself and dated it from the browser's clock. The machine it runs on is
-- nearly twelve hours ahead of this database (three separate servers answered "2026-11-02 17:25 GMT"
-- while that browser posted "2026-11-03 05:01"), so the rate was filed for an hour that has not
-- arrived yet. current_burn_rate() honours only rows whose start is in the past, found nothing live
-- for video, and fell back to the seeded 1.000 — which is exactly what every call on 2026-11-02 was
-- stamped with. The save worked. The date on it was wrong, and a wrong date is invisible.
--
-- So the clock moves out of the browser and into the database. Nothing below accepts a time from the
-- caller: the start is now(), the retirement is now(), and the answer the panel prints is the
-- function's own verdict read back from the same statement.

-- -- 1. What time is it where the money is kept? ---------------------------------------
-- The panel used the HTTP Date header to measure its own clock against the server's. That header is
-- not exposed to cross-origin scripts, so the read came back empty, the skew stayed unknown, and the
-- browser's own wrong time was used with no warning. This is the same question, answerable.
create or replace function public.sl_server_time()
returns timestamptz
language sql
stable
as $$
  select now();
$$;

comment on function public.sl_server_time() is
  'The clock that meters the money. A browser asks it how far behind or ahead itself is before it '
  'dares to show a rate as started or not started.';

-- -- 2. The rate each tab actually spends, as the database judges it ------------------
create or replace function public.sl_burn_rates_live()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'video',       public.current_burn_rate('video'),
    'audio',       public.current_burn_rate('audio'),
    'video_audio', public.current_burn_rate('video_audio'),
    'asked_at',    now()
  );
$$;

comment on function public.sl_burn_rates_live() is
  'What current_burn_rate() answers for all three tabs in one read. The panel shows this, not its own '
  'guess from the rate table, because the guess was the thing that was wrong.';

-- -- 3. Save a rate: the database dates it, and the next call pays it -----------------
create or replace function public.sl_set_burn_rate(
  p_modality   modality_flag,
  p_multiplier numeric,
  p_note       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_new      burn_rates;
  v_retired  int := 0;
  v_open     int := 0;
begin
  -- These run as their owner, so the table's own admin policy is bypassed and has to be re-applied
  -- here. Without this line every signed-up customer could reprice the pool.
  if not public.is_admin(auth.uid()) then
    return jsonb_build_object('ok', false, 'detail', 'only an administrator may set a burn rate');
  end if;

  if p_multiplier is null or p_multiplier <= 0 or p_multiplier > 100 then
    return jsonb_build_object('ok', false,
      'detail', 'a multiplier has to be above 0 and no more than 100');
  end if;

  -- Anything else still standing for that tab is retired now, so nothing outranks this row later.
  update public.burn_rates
     set retired_at = now()
   where modality = p_modality
     and retired_at is null;
  get diagnostics v_retired = row_count;

  insert into public.burn_rates (modality, multiplier, effective_from, note, created_by)
  values (p_modality, round(p_multiplier::numeric, 3), now(),
          nullif(trim(coalesce(p_note, '')), ''), auth.uid())
  returning * into v_new;

  -- A call already running is on the tab he just repriced. Leaving it on the figure it opened with
  -- is how one rate ends up charged two ways on the same day, so the open lease takes the new one.
  update public.usage_sessions
     set multiplier = v_new.multiplier
   where modality = p_modality
     and ended_at is null;
  get diagnostics v_open = row_count;

  return jsonb_build_object(
    'ok', true,
    'id', v_new.id,
    'modality', p_modality::text,
    'multiplier', v_new.multiplier,
    'effective_from', v_new.effective_from,
    'retired_with_it', v_retired,
    'calls_repriced', v_open,
    'in_force', public.current_burn_rate(p_modality)
  );
end;
$$;

comment on function public.sl_set_burn_rate(modality_flag, numeric, text) is
  'The only way a burn rate is saved. The start is the database clock, never the browser clock, and '
  'the reply carries the multiplier current_burn_rate() sees the same second, so the panel cannot '
  'report a save that is not yet in force.';

-- -- 4. Retire a row: same rule, no caller-supplied time ------------------------------
create or replace function public.sl_retire_burn_rate(p_id integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row burn_rates;
begin
  if not public.is_admin(auth.uid()) then
    return jsonb_build_object('ok', false, 'detail', 'only an administrator may retire a burn rate');
  end if;

  select * into v_row from public.burn_rates where id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'detail', 'there is no such rate row');
  end if;

  update public.burn_rates
     set retired_at = now()
   where id = p_id and retired_at is null;

  return jsonb_build_object(
    'ok', true, 'id', p_id, 'modality', v_row.modality::text,
    'multiplier', v_row.multiplier,
    'was_already_retired', v_row.retired_at is not null,
    'in_force', public.current_burn_rate(v_row.modality)
  );
end;
$$;

-- -- 5. Bring an older row into force now (the panel's "use this rate" press) ---------
create or replace function public.sl_use_burn_rate(p_id integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row   burn_rates;
  v_open  int := 0;
begin
  if not public.is_admin(auth.uid()) then
    return jsonb_build_object('ok', false, 'detail', 'only an administrator may move a rate into force');
  end if;

  select * into v_row from public.burn_rates where id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'detail', 'there is no such rate row');
  end if;

  update public.burn_rates
     set effective_from = now(),
         retired_at     = null
   where id = p_id;

  update public.usage_sessions
     set multiplier = v_row.multiplier
   where modality = v_row.modality
     and ended_at is null;
  get diagnostics v_open = row_count;

  return jsonb_build_object(
    'ok', true, 'id', p_id, 'modality', v_row.modality::text,
    'multiplier', v_row.multiplier,
    'effective_from', now(),
    'calls_repriced', v_open,
    'in_force', public.current_burn_rate(v_row.modality)
  );
end;
$$;

revoke execute on function public.sl_server_time(), public.sl_burn_rates_live(),
  public.sl_set_burn_rate(modality_flag, numeric, text),
  public.sl_retire_burn_rate(integer), public.sl_use_burn_rate(integer) from anon;
grant execute on function public.sl_server_time(), public.sl_burn_rates_live(),
  public.sl_set_burn_rate(modality_flag, numeric, text),
  public.sl_retire_burn_rate(integer), public.sl_use_burn_rate(integer)
  to authenticated, service_role;

-- -- 6. Settle the rows the browser already mis-dated ---------------------------------
-- Any rate that is un-retired and filed in this database's future has never taken effect and never
-- will, and the administrator has no box left that can put one there. The newest such row per tab is
-- pulled back to now, because it is the figure he last typed and means to be paying; older
-- future-dated rows are retired rather than revived, so they stop outranking it by sitting there.
do $$
declare
  v_mod   modality_flag;
  v_id    integer;
  v_mult  numeric;
  v_repriced integer;
begin
  foreach v_mod in array array['video','audio','video_audio']::modality_flag[]
  loop
    -- Plain variables rather than a record: a tab with no mis-dated row has to fall through this
    -- loop without touching a field that was never set.
    select id, multiplier into v_id, v_mult
      from public.burn_rates
     where modality = v_mod and retired_at is null and effective_from > now()
     order by effective_from desc, id desc
     limit 1;
    if v_id is not null then
      update public.burn_rates
         set effective_from = now(),
             note = trim(coalesce(note, '') || ' | start pulled back to the server clock, 2026-11-02')
       where id = v_id;
      raise notice 'rate row % (% x) brought into force now', v_id, v_mult;
    end if;

    update public.burn_rates
       set retired_at = now(),
           note = trim(coalesce(note, '') || ' | retired: dated ahead of the server and outranked')
     where modality = v_mod
       and retired_at is null
       and effective_from > now()
       and (v_id is null or id <> v_id);
  end loop;

  -- A call that is open this second opened under the wrong date too. The rate is a property of the
  -- tab, not of the customer, so the running lease is brought onto it rather than left to settle at
  -- 1x. Decart leases keep their forced 1.000, which is what start-session stamps them with.
  update public.usage_sessions s
     set multiplier = public.current_burn_rate(s.modality)
   where s.ended_at is null
     and s.modality is not null
     and coalesce(s.engine, 'fal') <> 'decart'
     and s.multiplier is distinct from public.current_burn_rate(s.modality);
  get diagnostics v_repriced = row_count;
  raise notice 'running calls brought onto the rate their tab now charges: %', v_repriced;
end $$;
