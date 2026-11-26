ALTER TABLE execution_policy ADD COLUMN skip_paid INTEGER NOT NULL DEFAULT 1 CHECK(skip_paid IN (0,1));
ALTER TABLE executors ADD COLUMN paid_control_version INTEGER NOT NULL DEFAULT 0;
