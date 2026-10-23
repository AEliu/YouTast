PRAGMA foreign_keys = ON;
CREATE TABLE users (
 id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, salt TEXT NOT NULL,
 password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE login_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
CREATE TABLE channels (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', feed_token TEXT NOT NULL UNIQUE,
 created_at INTEGER NOT NULL
);
CREATE INDEX channels_owner ON channels(user_id);
CREATE TABLE sources (
 id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
 url TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('video','playlist','author')),
 next_scan INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(channel_id,url)
);
CREATE INDEX sources_due ON sources(next_scan);
CREATE TABLE episodes (
 id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
 video_id TEXT NOT NULL, title TEXT NOT NULL, duration INTEGER NOT NULL DEFAULT 0,
 object_key TEXT, size INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
 UNIQUE(channel_id,video_id)
);
CREATE INDEX episodes_channel ON episodes(channel_id,created_at);
CREATE TABLE executors (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_seen INTEGER
);
CREATE TABLE jobs (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
 source_id TEXT REFERENCES sources(id) ON DELETE CASCADE, episode_id TEXT REFERENCES episodes(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('scan','transcode')),
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed')),
 attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, lease_until INTEGER,
 lease_token TEXT, executor_id TEXT, error TEXT, reserved_bytes INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX jobs_claim ON jobs(user_id,status,available_at,created_at);
CREATE INDEX jobs_lease ON jobs(status,lease_until);
CREATE UNIQUE INDEX jobs_active_source ON jobs(source_id) WHERE kind='scan' AND status IN ('queued','running');
CREATE UNIQUE INDEX jobs_episode ON jobs(episode_id) WHERE kind='transcode';
