ALTER TABLE sources ADD COLUMN sync_minutes INTEGER
 CHECK(sync_minutes IS NULL OR (typeof(sync_minutes)='integer' AND sync_minutes BETWEEN 15 AND 10080));
