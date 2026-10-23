CREATE INDEX episodes_objects ON episodes(object_key) WHERE object_key IS NOT NULL;
