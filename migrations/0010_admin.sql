ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK(role IN('user','admin'));
ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN(0,1));
ALTER TABLE users ADD COLUMN storage_limit_bytes INTEGER CHECK(storage_limit_bytes>=0);
ALTER TABLE users ADD COLUMN monthly_transfer_limit_bytes INTEGER CHECK(monthly_transfer_limit_bytes>=0);
CREATE TABLE app_config(id INTEGER PRIMARY KEY CHECK(id=1),max_storage_bytes INTEGER CHECK(max_storage_bytes>=0),default_user_storage_bytes INTEGER CHECK(default_user_storage_bytes>=0),default_monthly_transfer_bytes INTEGER NOT NULL DEFAULT 0 CHECK(default_monthly_transfer_bytes>=0),max_monthly_transfer_bytes INTEGER NOT NULL DEFAULT 0 CHECK(max_monthly_transfer_bytes>=0),registration_enabled INTEGER NOT NULL DEFAULT 1 CHECK(registration_enabled IN(0,1)));
INSERT INTO app_config(id) VALUES(1);
CREATE TABLE usage_daily(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,day TEXT NOT NULL,bytes INTEGER NOT NULL DEFAULT 0 CHECK(bytes>=0),requests INTEGER NOT NULL DEFAULT 0 CHECK(requests>=0),PRIMARY KEY(user_id,day));
CREATE INDEX usage_daily_day ON usage_daily(day);
CREATE TABLE admin_audit(id TEXT PRIMARY KEY,actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,target_id TEXT REFERENCES users(id) ON DELETE SET NULL,action TEXT NOT NULL,details TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL);
CREATE INDEX admin_audit_created ON admin_audit(created_at);
CREATE TRIGGER keep_last_admin BEFORE UPDATE OF role,disabled ON users
WHEN OLD.role='admin' AND OLD.disabled=0 AND (NEW.role!='admin' OR NEW.disabled!=0)
 AND NOT EXISTS(SELECT 1 FROM users WHERE id!=OLD.id AND role='admin' AND disabled=0)
BEGIN SELECT RAISE(ABORT,'last_admin'); END;
CREATE TRIGGER keep_last_admin_delete BEFORE DELETE ON users
WHEN OLD.role='admin' AND OLD.disabled=0 AND NOT EXISTS(SELECT 1 FROM users WHERE id!=OLD.id AND role='admin' AND disabled=0)
BEGIN SELECT RAISE(ABORT,'last_admin'); END;
