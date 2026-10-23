CREATE TABLE invitations(
 id TEXT PRIMARY KEY,
 code_hash TEXT NOT NULL UNIQUE,
 hint TEXT NOT NULL,
 label TEXT NOT NULL DEFAULT '',
 max_uses INTEGER NOT NULL DEFAULT 1 CHECK(max_uses>=0),
 used_count INTEGER NOT NULL DEFAULT 0 CHECK(used_count>=0),
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN(0,1)),
 expires_at INTEGER,
 legacy INTEGER NOT NULL DEFAULT 0 CHECK(legacy IN(0,1)),
 created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
 created_at INTEGER NOT NULL,
 CHECK(max_uses=0 OR used_count<=max_uses)
);
CREATE INDEX invitations_created ON invitations(created_at);
ALTER TABLE users ADD COLUMN invite_id TEXT REFERENCES invitations(id);
CREATE INDEX users_invite ON users(invite_id);
-- Consumption and user creation belong to the same SQLite statement. A failed
-- insert rolls back consumption; concurrent requests cannot exceed max_uses.
CREATE TRIGGER redeem_invitation BEFORE INSERT ON users
WHEN NEW.invite_id IS NOT NULL
BEGIN
 SELECT CASE WHEN (SELECT registration_enabled FROM app_config WHERE id=1)!=1
  THEN RAISE(ABORT,'registration_closed') END;
 UPDATE invitations SET used_count=used_count+1
 WHERE id=NEW.invite_id AND enabled=1
 AND (expires_at IS NULL OR expires_at>unixepoch())
 AND (max_uses=0 OR used_count<max_uses);
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'invite_unavailable') END;
END;
