-- C2a: per-account InvenFlow auth token override is optional.
-- v1 always uses the global service token configured in Settings, so existing
-- callers no longer have to populate this column. The column itself stays
-- (the schema field still exists, just nullable) so a future per-account
-- override UI does not require another migration.
ALTER TABLE "Account" ALTER COLUMN "invenflowAuthTokenRef" DROP NOT NULL;
