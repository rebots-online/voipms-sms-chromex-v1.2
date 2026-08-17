BEGIN;

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS is_platform_admin boolean NOT NULL DEFAULT false;

COMMIT;
