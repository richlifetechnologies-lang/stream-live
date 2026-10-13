-- The version floor, shipped with the release it belongs to. See the 1.5.1 file for
-- the convention.
--
-- 1.5.1 cannot serve video at all: its content policy allows the Decart API hosts but
-- not the regional media host (*.lkc.decart.ai) that the signalling socket hands back,
-- so every trial call dies at "could not establish signal connection". There is no
-- setting inside that build that fixes it, so nobody should be able to stay on it.

update public.app_config
   set min_supported_version = '1.5.2',
       latest_version        = '1.5.2'
 where id = 1;
