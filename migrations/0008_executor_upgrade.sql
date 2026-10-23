-- Drain an older executor without revoking a running job's heartbeat/upload lease.
ALTER TABLE executors ADD COLUMN minimum_protocol INTEGER NOT NULL DEFAULT 1 CHECK(minimum_protocol IN (1,2));
