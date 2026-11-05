ALTER TABLE approval_requests ADD COLUMN capability_id TEXT REFERENCES capabilities(id);
ALTER TABLE approval_requests ADD COLUMN subject_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE approval_requests ADD COLUMN subject_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE approval_requests ADD COLUMN payload_hash TEXT;
ALTER TABLE approval_requests ADD COLUMN canonical_payload_json TEXT;
ALTER TABLE approval_requests ADD COLUMN lease_token_hash TEXT;
ALTER TABLE approval_requests ADD COLUMN lease_issued_at TEXT;
ALTER TABLE approval_requests ADD COLUMN lease_used_at TEXT;

CREATE INDEX IF NOT EXISTS idx_approval_requests_capability_id ON approval_requests(capability_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_payload_hash ON approval_requests(payload_hash);
CREATE INDEX IF NOT EXISTS idx_approval_requests_lease_token_hash ON approval_requests(lease_token_hash);
