CREATE TABLE IF NOT EXISTS agent_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  steps_json TEXT NOT NULL DEFAULT '[]',
  schedule_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  routine_id TEXT REFERENCES routines(id) ON DELETE SET NULL,
  job_type TEXT NOT NULL DEFAULT 'routine.run',
  input_json TEXT NOT NULL DEFAULT '{}',
  schedule_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'paused', 'completed', 'cancelled')
  ),
  next_run_at TEXT,
  last_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'running', 'completed', 'failed', 'cancelled')
  ),
  routine_id TEXT REFERENCES routines(id) ON DELETE SET NULL,
  skill_id TEXT,
  input_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS job_logs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('debug', 'info', 'warn', 'error')),
  message TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  version TEXT NOT NULL,
  permissions_json TEXT NOT NULL DEFAULT '[]',
  config_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS heartbeat_events (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('ok', 'warn', 'error')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status_next_run_at
  ON scheduled_tasks(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_routine_id
  ON scheduled_tasks(routine_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status_available_at
  ON jobs(status, available_at);
CREATE INDEX IF NOT EXISTS idx_jobs_routine_id
  ON jobs(routine_id);
CREATE INDEX IF NOT EXISTS idx_jobs_skill_id
  ON jobs(skill_id);
CREATE INDEX IF NOT EXISTS idx_job_logs_job_id
  ON job_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_heartbeat_events_created_at
  ON heartbeat_events(created_at);
