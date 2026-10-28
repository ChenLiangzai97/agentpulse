-- Test/offline rollback only. For production application rollback, KEEP these additive tables.
-- Dropping them requires a backup and migration-journal reconciliation before a forward upgrade.
BEGIN;
DROP TABLE IF EXISTS provider_interactions;
DROP TABLE IF EXISTS session_control_bindings;
DROP TABLE IF EXISTS provider_instances;
COMMIT;
