-- The version floor, shipped with the release it belongs to.
--
-- min_supported_version is the kill switch: start-session answers 412 update_required
-- to any build below it, so an old install is stopped at the door instead of running
-- against a gateway it no longer agrees with. It has to move at the same moment the
-- schema does, which is why it lives here rather than in someone's to-do list.
--
-- 1.5.0 has no way to tell the gateway that a video frame ever reached its screen, so
-- under the new billing rule a 1.5.0 video call would be charged for nothing. The floor
-- is therefore this release: old builds are told to update rather than served free.
--
-- Convention from here on: every release ships one of these files with its own number
-- in it, so going live moves the floor automatically. The panel's Settings tab can
-- still override it at any time without a migration.

update public.app_config
   set min_supported_version = '1.5.1',
       latest_version        = '1.5.1'
 where id = 1;
