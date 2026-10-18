-- Rollback da migration 20261018100000_restore_lock

DROP TABLE IF EXISTS "restore_locks";
DROP TYPE IF EXISTS "RestoreLockStatus";
