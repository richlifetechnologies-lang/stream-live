-- ============================================================================
-- The calls you corrected now carry the correction on their own row
-- ============================================================================
-- The catch-up taken on 2026-11-02 moved TWO places: his pool, and one 'adjust' line on his ledger.
-- It did not move the third place the figure lives, which is the call record itself. Each of those
-- delivered calls still sits in usage_sessions with the 1.000 multiplier the broken meter stamped it
-- with, and the smaller billed_minutes that came with it. So every view that reads the call rows
-- disagreed with his balance by exactly the amount taken back:
--   * the panel's paid-calls card ("minutes you charged"),
--   * the panel's calls / leases tab (the per-call minutes column),
--   * the panel's airtime tab ("minutes used from their pools", per account and in total).
-- His own app already tells the truth: his call list shows the tab and the date and never a minute
-- figure, and his credit list carries the correction as its own ledger line.
--
-- This file re-states, on each call row, the rate that row should have carried. Nothing else.
--
--   * NO MONEY MOVES. The clawback was posted once, through the wallet routine, in the previous
--     window, and that window guards against a second posting. These rows change what the record
--     SAYS the call owed, not what was taken. The block below snapshots the ledger and the pool
--     before it writes and raises if either has moved, so the whole thing rolls back rather than
--     leaving an account charged twice.
--   * the rows to re-price are read with the SAME predicate and the SAME arithmetic the clawback used
--     (same account, same server day, billed_minutes above zero, multiplier strictly below the rate now
--     in force), so the figure predicted here is the same sum that produced the amount taken.
--   * if that prediction is not EXACTLY equal to what the ledger actually took, the block raises and
--     nothing is changed. A record is never made to claim a number the money never moved by.
--   * after a row carries the rate in force it stops matching that predicate, so a second pass of this
--     file finds nothing to correct rather than correcting twice.
--   * the wall-clock time the customer actually spent (real_minutes, minutes) is deliberately untouched
--     -- only the rate and the charged figure are corrected. What the video service really burned did
--     not change; what the call owes did.
--
-- Going forward this cannot recur: a saved rate is now dated by the server, starts the instant it is
-- saved, re-prices any call already running, and sl_start_session stamps every new call with the rate
-- in force at dial time.

-- -- Re-price the call rows a catch-up was actually taken for ------------------
do $$
declare
  v_row          record;
  v_ids          uuid[];
  v_predict      numeric;
  v_before       numeric;
  v_after        numeric;
  v_written      integer;
  v_calls        integer;
  v_ledger_top   bigint;
  v_balance      numeric;
  v_balance_now  numeric;
begin
  -- Anything written to the money journal by this file would be a second charge for the same
  -- shortfall. Snapshot the journal's newest row first so the block can prove it added none.
  select coalesce(max(id), 0) into v_ledger_top from public.credit_ledger;

  for v_row in
    -- every account a catch-up was posted for, and exactly how much it took from them. Grouped by
    -- account and server day because that is the window the clawback summed over.
    select l.user_id                     as uid,
           l.created_at::date            as the_day,
           round(abs(sum(l.delta)), 3)   as posted,
           count(*)::int                 as postings
      from public.credit_ledger l
     where l.kind = 'adjust'
       and coalesce(l.reason, '') like 'burn-rate catch-up 2026-11-02%'
     group by 1, 2
  loop
    if v_row.postings <> 1 then
      raise exception 'record repair refused: account % on % has % catch-up ledger row(s) and one was expected - refusing to guess which record each of them covers, and nothing was changed',
        v_row.uid, v_row.the_day, v_row.postings;
    end if;

    -- the pool the money came out of, as it stands before any record is touched
    select balance into v_balance
      from public.credit_balances
     where user_id = v_row.uid and modality = 'video';

    select coalesce(array_agg(x.id), '{}'::uuid[]),
           coalesce(round(sum(x.the_shortfall), 3), 0),
           coalesce(round(sum(x.the_record), 3), 0),
           count(*)::int
      into v_ids, v_predict, v_before, v_calls
      from (
        select s.id,
               s.billed_minutes as the_record,
               round(s.billed_minutes
                     * (public.current_burn_rate(s.modality) / s.multiplier - 1), 3) as the_shortfall
          from public.usage_sessions s
         where s.user_id    = v_row.uid
           and s.modality   is not null
           and s.started_at >= v_row.the_day
           and s.started_at <  v_row.the_day + 1
           and s.billed_minutes > 0
           and s.multiplier is not null and s.multiplier > 0
           and s.multiplier < public.current_burn_rate(s.modality)
      ) x;

    if v_calls = 0 then
      raise notice 'account % on %: no call row sits below the rate in force - the records already carry it',
        v_row.uid, v_row.the_day;
      continue;
    end if;

    if v_predict <> v_row.posted then
      raise exception 'record repair refused for account % on %: these % call rows predict % minute(s) of shortfall but the ledger actually took % - stopping, nothing on this account was changed',
        v_row.uid, v_row.the_day, v_calls, v_predict, v_row.posted;
    end if;

    update public.usage_sessions s
       set billed_minutes = round(s.billed_minutes * public.current_burn_rate(s.modality) / s.multiplier, 3),
           multiplier     = public.current_burn_rate(s.modality)
     where s.id = any(v_ids);
    get diagnostics v_written = row_count;

    -- The rows themselves, read back after the write, must total the old figure plus exactly the money
    -- the ledger took. This is the point of the whole file, checked against the server.
    select round(coalesce(sum(billed_minutes), 0), 3) into v_after
      from public.usage_sessions
     where id = any(v_ids);

    if v_after <> round(v_before + v_row.posted, 3) then
      raise exception 'record repair rolled back: the call rows now total % but must total %, being the % they drained at the old figure plus the % the ledger took',
        v_after, round(v_before + v_row.posted, 3), v_before, v_row.posted;
    end if;

    -- and the pool must be sitting on the same figure it was sitting on before this block ran
    select balance into v_balance_now
      from public.credit_balances
     where user_id = v_row.uid and modality = 'video';

    if v_balance_now is distinct from v_balance then
      raise exception 'record repair rolled back: the pool moved from % to % while only call records were being corrected, and this file must never touch the money',
        v_balance, v_balance_now;
    end if;

    raise notice 'record repair done: account % on %, % call rows re-priced from % to % minute(s), the difference being the % the ledger took, pool still at %',
      v_row.uid, v_row.the_day, v_written, v_before, v_after, v_row.posted, v_balance_now;
  end loop;

  if (select coalesce(max(id), 0) from public.credit_ledger) > v_ledger_top then
    raise exception 'record repair rolled back: it wrote a ledger row, which means it charged again';
  end if;
end $$;
