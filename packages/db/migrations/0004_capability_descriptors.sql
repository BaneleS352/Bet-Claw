ALTER TABLE capabilities ADD COLUMN version TEXT NOT NULL DEFAULT '0.1.0';
ALTER TABLE capabilities ADD COLUMN risk TEXT NOT NULL DEFAULT 'low' CHECK (risk IN ('low', 'medium', 'high'));
ALTER TABLE capabilities ADD COLUMN effects_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE capabilities ADD COLUMN requires_approval INTEGER NOT NULL DEFAULT 0 CHECK (requires_approval IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_capability_grants_agent_id ON capability_grants(agent_id);
CREATE INDEX IF NOT EXISTS idx_capability_grants_user_id ON capability_grants(user_id);
