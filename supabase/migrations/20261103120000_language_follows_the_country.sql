-- v1.8.33 — the language a country suggests.
--
-- Why this is a database function and not a list inside the app: the app on a customer's
-- machine cannot be re-worded after it ships, and a mapping of who speaks what is exactly the
-- kind of thing that gets a correction. So the sentence "this address suggests French" is
-- decided here, and the next installer is not needed to change it.
--
-- What this is NOT: it is not a location system anyone depends on. Nothing about a price, a
-- shelf, a package, a payment door, a wallet or which engine serves the call is read from
-- country — that rule is already written on the column itself (see the two-shelves migration)
-- and this function does not change it. The flag is a wrong guess for a customer on a VPN, and
-- for a language that is only a wrong guess at the app's opening screen: his own language
-- button, once touched on that machine, is remembered and the suggestion is never applied
-- again. Ghana, and every country not listed below, answers 'en'.
--
-- The list is deliberately conservative, and the omissions are decisions:
--   * BE, CH, CA and LU are left out because two languages share them and a country code cannot
--     tell a Flemish customer from a Walloon one, or Quebec from the rest of Canada. They get
--     English to start with and the button to fix it.
--   * MA, DZ and TN go to Arabic rather than French, because Arabic is the official language
--     even where everyday speech is a mixture.
--   * Israel, Malta, Cyprus and the Philippines are left on English on purpose: they are
--     countries where the app's five languages are each only part of the picture.

drop function if exists public.sl_lang_for_country(text);

create or replace function public.sl_lang_for_country(p_country text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_country is null then 'en'
    when upper(p_country) in (
      'ES','MX','AR','CO','PE','CL','VE','EC','GT','BO','DO','HN','PY','SV','NI','CR','PA','UY','CU','PR'
    ) then 'es'
    when upper(p_country) in ('PT','BR','AO','MZ','CV','ST','GW') then 'pt'
    when upper(p_country) in (
      'FR','CD','CM','CI','GA','CG','SN','ML','BF','NE','TG','BJ','MG','HT','MC','RE','GF'
    ) then 'fr'
    when upper(p_country) in (
      'EG','SA','IQ','JO','LY','SD','YE','SY','LB','OM','AE','QA','BH','KW','PS','MR','SO','DJ','KM','EH','MA','DZ','TN'
    ) then 'ar'
    else 'en'
  end;
$$;

comment on function public.sl_lang_for_country(text) is
  'The app language a two-letter country suggests: en, es, pt, fr or ar — never anything else, and en for every country not named. A suggestion only: the desktop app follows it solely for an account whose customer has never used the language button on that machine, and no price, shelf, package, payment door, wallet or engine is ever read from the country.';

grant execute on function public.sl_lang_for_country(text) to authenticated, service_role;
