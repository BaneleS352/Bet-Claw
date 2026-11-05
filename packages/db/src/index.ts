import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadConfig } from "@openclaw/config";
import { redactSensitiveText, redactSensitiveValue } from "@openclaw/shared";

export type DatabaseConnection = DatabaseSync;

export type MigrationResult = {
  applied: string[];
};

export type InitializedDatabase = {
  database: DatabaseConnection;
  migrations: MigrationResult;
};

export type AgentRecord = {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ThreadRecord = {
  id: string;
  agentId: string | null;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type MessageRecord = {
  id: string;
  threadId: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  metadataJson: string;
  createdAt: string;
};

export type ExecutionRecord = {
  id: string;
  threadId: string | null;
  agentId: string | null;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
};

export type ExecutionEventRecord = {
  id: string;
  executionId: string;
  type: string;
  payloadJson: string;
  createdAt: string;
};

export type DocumentRecord = {
  id: string;
  title: string;
  sourceUri: string | null;
  mimeType: string | null;
  contentHash: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DocumentChunkSearchRecord = {
  chunkId: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  tokenCount: number | null;
  metadataJson: string;
  documentTitle: string;
  sourceUri: string | null;
  mimeType: string | null;
  embeddingProvider: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  embeddingJson: string | null;
};

export type CapabilityRisk = "low" | "medium" | "high";

export type CapabilityRecord = {
  id: string;
  name: string;
  description: string | null;
  version: string;
  risk: CapabilityRisk;
  effectsJson: string;
  requiresApproval: boolean;
  createdAt: string;
};

export type CapabilityGrantRecord = {
  id: string;
  capabilityId: string;
  agentId: string | null;
  userId: string | null;
  grantedByUserId: string | null;
  createdAt: string;
};

export type AuditEventRecord = {
  id: string;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  payloadJson: string;
  createdAt: string;
};

export type RoutineRecord = {
  id: string;
  name: string;
  description: string | null;
  stepsJson: string;
  scheduleJson: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ScheduledTaskStatus = "active" | "paused" | "completed" | "cancelled";

export type ScheduledTaskRecord = {
  id: string;
  name: string;
  routineId: string | null;
  jobType: string;
  inputJson: string;
  scheduleJson: string;
  status: ScheduledTaskStatus;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type JobRecord = {
  id: string;
  type: string;
  status: JobStatus;
  routineId: string | null;
  skillId: string | null;
  inputJson: string;
  resultJson: string | null;
  errorJson: string | null;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type JobLogLevel = "debug" | "info" | "warn" | "error";

export type JobLogRecord = {
  id: string;
  jobId: string;
  level: JobLogLevel;
  message: string;
  metadataJson: string;
  createdAt: string;
};

export type SkillRecord = {
  id: string;
  name: string;
  description: string | null;
  version: string;
  permissionsJson: string;
  configJson: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type HeartbeatEventRecord = {
  id: string;
  status: "ok" | "warn" | "error";
  payloadJson: string;
  createdAt: string;
};

export type AgentStateRecord = {
  key: string;
  valueJson: string;
  updatedAt: string;
};

export type ApprovalRequestRecord = {
  id: string;
  executionId: string | null;
  requestedByUserId: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  reason: string | null;
  payloadJson: string;
  resolvedByUserId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  capabilityId: string | null;
  subjectAgentId: string | null;
  subjectUserId: string | null;
  payloadHash: string | null;
  canonicalPayloadJson: string | null;
  leaseTokenHash: string | null;
  leaseIssuedAt: string | null;
  leaseUsedAt: string | null;
};

export function openDatabase(
  dbPath = resolve(defaultWorkspaceRoot(), "data", "openclaw.sqlite")
): DatabaseConnection {
  if (dbPath === ":memory:") {
    const database = new DatabaseSync(dbPath);
    database.exec("PRAGMA foreign_keys = ON;");

    return database;
  }

  const resolvedPath = resolve(process.cwd(), dbPath);
  mkdirSync(dirname(resolvedPath), { recursive: true });

  const database = new DatabaseSync(resolvedPath);
  database.exec("PRAGMA foreign_keys = ON;");

  return database;
}

export function initializeDatabase(dbPath?: string): InitializedDatabase {
  const database = openDatabase(dbPath);

  return {
    database,
    migrations: migrate(database)
  };
}

export function migrate(database = openDatabase()): MigrationResult {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const migrationIds = database
    .prepare("SELECT id FROM schema_migrations ORDER BY id")
    .all()
    .map((row) => String((row as { id: unknown }).id));
  const appliedIds = new Set(migrationIds);
  const newlyApplied: string[] = [];

  for (const migration of readMigrations()) {
    if (appliedIds.has(migration.id)) {
      continue;
    }

    database.exec("BEGIN;");
    try {
      database.exec(migration.sql);
      database.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(migration.id);
      database.exec("COMMIT;");
      newlyApplied.push(migration.id);
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }

  return { applied: newlyApplied };
}

export function createSettingsRepository(database: DatabaseConnection) {
  return {
    get(key: string): string | null {
      const row = database.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as
        | { value_json: string }
        | undefined;

      return row?.value_json ?? null;
    },
    set(key: string, valueJson: string): void {
      database
        .prepare(
          `
          INSERT INTO settings (key, value_json, updated_at)
          VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = CURRENT_TIMESTAMP
        `
        )
        .run(key, valueJson);
    }
  };
}

export const createMetadataRepository = createSettingsRepository;

export function createAgentRepository(database: DatabaseConnection) {
  return {
    ensureDefault(input: { model: string; systemPrompt?: string | null }): AgentRecord {
      database
        .prepare(
          `
          INSERT INTO agents (id, name, description, system_prompt, model)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `
        )
        .run(
          "default",
          "Default local agent",
          "OpenClaw local chat agent",
          input.systemPrompt ?? "You are OpenClaw, a local assistant.",
          input.model
        );

      const agent = this.getById("default");

      if (!agent) {
        throw new Error("Failed to create default agent.");
      }

      return agent;
    },
    getById(id: string): AgentRecord | null {
      const row = database
        .prepare(
          `
          SELECT id, name, description, system_prompt, model, created_at, updated_at
          FROM agents
          WHERE id = ?
        `
        )
        .get(id) as
        | {
            id: string;
            name: string;
            description: string | null;
            system_prompt: string | null;
            model: string | null;
            created_at: string;
            updated_at: string;
          }
        | undefined;

      return row ? mapAgent(row) : null;
    }
  };
}

export function createThreadRepository(database: DatabaseConnection) {
  return {
    create(input: { agentId?: string | null; title: string }): ThreadRecord {
      const id = randomUUID();

      database
        .prepare(
          `
          INSERT INTO threads (id, agent_id, title)
          VALUES (?, ?, ?)
        `
        )
        .run(id, input.agentId ?? null, input.title);

      const thread = this.getById(id);

      if (!thread) {
        throw new Error("Failed to create thread.");
      }

      return thread;
    },
    getById(id: string): ThreadRecord | null {
      const row = database
        .prepare(
          `
          SELECT id, agent_id, title, status, created_at, updated_at
          FROM threads
          WHERE id = ?
        `
        )
        .get(id) as
        | {
            id: string;
            agent_id: string | null;
            title: string;
            status: string;
            created_at: string;
            updated_at: string;
          }
        | undefined;

      return row ? mapThread(row) : null;
    },
    list(): ThreadRecord[] {
      return database
        .prepare(
          `
          SELECT id, agent_id, title, status, created_at, updated_at
          FROM threads
          ORDER BY updated_at DESC, created_at DESC
        `
        )
        .all()
        .map((row) => mapThread(row as Parameters<typeof mapThread>[0]));
    },
    touch(id: string): void {
      database.prepare("UPDATE threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    }
  };
}

export function createMessageRepository(database: DatabaseConnection) {
  return {
    create(input: {
      threadId: string;
      role: MessageRecord["role"];
      content: string;
      metadataJson?: string;
    }): MessageRecord {
      const id = randomUUID();

      database
        .prepare(
          `
          INSERT INTO messages (id, thread_id, role, content, metadata_json)
          VALUES (?, ?, ?, ?, ?)
        `
        )
        .run(id, input.threadId, input.role, input.content, input.metadataJson ?? "{}");

      const message = this.getById(id);

      if (!message) {
        throw new Error("Failed to create message.");
      }

      return message;
    },
    getById(id: string): MessageRecord | null {
      const row = database
        .prepare(
          `
          SELECT id, thread_id, role, content, metadata_json, created_at
          FROM messages
          WHERE id = ?
        `
        )
        .get(id) as Parameters<typeof mapMessage>[0] | undefined;

      return row ? mapMessage(row) : null;
    },
    listByThread(threadId: string): MessageRecord[] {
      return database
        .prepare(
          `
          SELECT id, thread_id, role, content, metadata_json, created_at
          FROM messages
          WHERE thread_id = ?
          ORDER BY created_at ASC
        `
        )
        .all(threadId)
        .map((row) => mapMessage(row as Parameters<typeof mapMessage>[0]));
    }
  };
}

export function createExecutionRepository(database: DatabaseConnection) {
  return {
    create(input: { threadId: string; agentId?: string | null }): ExecutionRecord {
      const id = randomUUID();

      database
        .prepare(
          `
          INSERT INTO executions (id, thread_id, agent_id, status, started_at)
          VALUES (?, ?, ?, 'running', CURRENT_TIMESTAMP)
        `
        )
        .run(id, input.threadId, input.agentId ?? null);

      const execution = this.getById(id);

      if (!execution) {
        throw new Error("Failed to create execution.");
      }

      return execution;
    },
    getById(id: string): ExecutionRecord | null {
      const row = database
        .prepare(
          `
          SELECT id, thread_id, agent_id, status, started_at, completed_at, created_at
          FROM executions
          WHERE id = ?
        `
        )
        .get(id) as Parameters<typeof mapExecution>[0] | undefined;

      return row ? mapExecution(row) : null;
    },
    complete(id: string): void {
      database
        .prepare("UPDATE executions SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(id);
    },
    fail(id: string): void {
      database
        .prepare("UPDATE executions SET status = 'failed', completed_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(id);
    }
  };
}

export function createExecutionEventRepository(database: DatabaseConnection) {
  return {
    record(event: { executionId: string; type: string; payloadJson?: string }): string {
      const id = randomUUID();

      database
        .prepare(
          `
          INSERT INTO execution_events (id, execution_id, type, payload_json)
          VALUES (?, ?, ?, ?)
        `
        )
        .run(id, event.executionId, event.type, event.payloadJson ?? "{}");

      return id;
    },
    listByExecution(executionId: string): ExecutionEventRecord[] {
      return database
        .prepare(
          `
          SELECT id, execution_id, type, payload_json, created_at
          FROM execution_events
          WHERE execution_id = ?
          ORDER BY created_at ASC
        `
        )
        .all(executionId)
        .map((row) => mapExecutionEvent(row as Parameters<typeof mapExecutionEvent>[0]));
    }
  };
}

export function createDocumentRepository(database: DatabaseConnection) {
  return {
    findBySourceUri(sourceUri: string): DocumentRecord | null {
      const row = database
        .prepare(
          `
          SELECT id, title, source_uri, mime_type, content_hash, created_at, updated_at
          FROM documents
          WHERE source_uri = ?
        `
        )
        .get(sourceUri) as Parameters<typeof mapDocument>[0] | undefined;

      return row ? mapDocument(row) : null;
    },
    upsertDocument(input: {
      title: string;
      sourceUri: string;
      mimeType: string;
      contentHash: string;
    }): DocumentRecord {
      const existing = this.findBySourceUri(input.sourceUri);
      const id = existing?.id ?? randomUUID();

      database
        .prepare(
          `
          INSERT INTO documents (id, title, source_uri, mime_type, content_hash, updated_at)
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(source_uri) DO UPDATE SET
            title = excluded.title,
            mime_type = excluded.mime_type,
            content_hash = excluded.content_hash,
            updated_at = CURRENT_TIMESTAMP
        `
        )
        .run(id, input.title, input.sourceUri, input.mimeType, input.contentHash);

      const document = this.findBySourceUri(input.sourceUri);

      if (!document) {
        throw new Error("Failed to upsert document.");
      }

      return document;
    },
    listChunksWithEmbeddings(): DocumentChunkSearchRecord[] {
      return database
        .prepare(
          `
          SELECT
            c.id AS chunk_id,
            c.document_id,
            c.chunk_index,
            c.content,
            c.token_count,
            c.metadata_json,
            d.title AS document_title,
            d.source_uri,
            d.mime_type,
            e.provider AS embedding_provider,
            e.model AS embedding_model,
            e.dimensions AS embedding_dimensions,
            e.embedding_json
          FROM document_chunks c
          JOIN documents d ON d.id = c.document_id
          LEFT JOIN document_embeddings e ON e.id = (
            SELECT id
            FROM document_embeddings
            WHERE chunk_id = c.id
            ORDER BY created_at DESC
            LIMIT 1
          )
          ORDER BY d.updated_at DESC, d.title ASC, c.chunk_index ASC
        `
        )
        .all()
        .map((row) => mapDocumentChunkSearch(row as Parameters<typeof mapDocumentChunkSearch>[0]));
    },
    replaceChunks(
      documentId: string,
      chunks: Array<{
        content: string;
        tokenCount: number;
        metadataJson?: string;
        embedding: number[];
        provider: string;
        model: string;
      }>
    ): void {
      database.prepare("DELETE FROM document_chunks WHERE document_id = ?").run(documentId);

      for (const [index, chunk] of chunks.entries()) {
        const chunkId = randomUUID();
        const embeddingId = randomUUID();

        database
          .prepare(
            `
            INSERT INTO document_chunks (
              id,
              document_id,
              chunk_index,
              content,
              token_count,
              metadata_json
            )
            VALUES (?, ?, ?, ?, ?, ?)
          `
          )
          .run(chunkId, documentId, index, chunk.content, chunk.tokenCount, chunk.metadataJson ?? "{}");
        database
          .prepare(
            `
            INSERT INTO document_embeddings (
              id,
              chunk_id,
              provider,
              model,
              dimensions,
              embedding_json
            )
            VALUES (?, ?, ?, ?, ?, ?)
          `
          )
          .run(
            embeddingId,
            chunkId,
            chunk.provider,
            chunk.model,
            chunk.embedding.length,
            JSON.stringify(chunk.embedding)
          );
      }
    }
  };
}

export function createCapabilityRepository(database: DatabaseConnection) {
  return {
    upsertDescriptor(input: {
      id: string;
      version: string;
      risk: CapabilityRisk;
      effectsJson: string;
      requiresApproval: boolean;
      description?: string | null;
    }): CapabilityRecord {
      database
        .prepare(
          `
          INSERT INTO capabilities (
            id,
            name,
            description,
            version,
            risk,
            effects_json,
            requires_approval
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            version = excluded.version,
            risk = excluded.risk,
            effects_json = excluded.effects_json,
            requires_approval = excluded.requires_approval
        `
        )
        .run(
          input.id,
          input.id,
          input.description ?? null,
          input.version,
          input.risk,
          input.effectsJson,
          input.requiresApproval ? 1 : 0
        );

      const descriptor = this.getById(input.id);

      if (!descriptor) {
        throw new Error("Failed to upsert capability descriptor.");
      }

      return descriptor;
    },
    getById(id: string): CapabilityRecord | null {
      const row = database
        .prepare(
          `
          SELECT
            id,
            name,
            description,
            version,
            risk,
            effects_json,
            requires_approval,
            created_at
          FROM capabilities
          WHERE id = ?
        `
        )
        .get(id) as Parameters<typeof mapCapability>[0] | undefined;

      return row ? mapCapability(row) : null;
    },
    list(): CapabilityRecord[] {
      return database
        .prepare(
          `
          SELECT
            id,
            name,
            description,
            version,
            risk,
            effects_json,
            requires_approval,
            created_at
          FROM capabilities
          ORDER BY id ASC
        `
        )
        .all()
        .map((row) => mapCapability(row as Parameters<typeof mapCapability>[0]));
    },
    listGrants(): CapabilityGrantRecord[] {
      return database
        .prepare(
          `
          SELECT
            id,
            capability_id,
            agent_id,
            user_id,
            granted_by_user_id,
            created_at
          FROM capability_grants
          ORDER BY capability_id ASC, created_at ASC
        `
        )
        .all()
        .map((row) => mapCapabilityGrant(row as Parameters<typeof mapCapabilityGrant>[0]));
    },
    ensureGrant(input: {
      capabilityId: string;
      agentId?: string | null;
      userId?: string | null;
      grantedByUserId?: string | null;
    }): CapabilityGrantRecord {
      const agentId = input.agentId ?? null;
      const userId = input.userId ?? null;

      if ((agentId === null && userId === null) || (agentId !== null && userId !== null)) {
        throw new Error("Capability grants require exactly one subject.");
      }

      const existing = this.findGrant({
        capabilityId: input.capabilityId,
        agentId,
        userId
      });

      if (existing) {
        return existing;
      }

      const id = randomUUID();

      database
        .prepare(
          `
          INSERT INTO capability_grants (
            id,
            capability_id,
            agent_id,
            user_id,
            granted_by_user_id
          )
          VALUES (?, ?, ?, ?, ?)
        `
        )
        .run(id, input.capabilityId, agentId, userId, input.grantedByUserId ?? null);

      const grant = this.findGrant({
        capabilityId: input.capabilityId,
        agentId,
        userId
      });

      if (!grant) {
        throw new Error("Failed to create capability grant.");
      }

      return grant;
    },
    findGrant(input: {
      capabilityId: string;
      agentId?: string | null;
      userId?: string | null;
    }): CapabilityGrantRecord | null {
      const row = database
        .prepare(
          `
          SELECT
            id,
            capability_id,
            agent_id,
            user_id,
            granted_by_user_id,
            created_at
          FROM capability_grants
          WHERE capability_id = ?
            AND (
              (agent_id IS NOT NULL AND agent_id = ?) OR
              (user_id IS NOT NULL AND user_id = ?)
            )
          ORDER BY created_at ASC
          LIMIT 1
        `
        )
        .get(input.capabilityId, input.agentId ?? null, input.userId ?? null) as
        | Parameters<typeof mapCapabilityGrant>[0]
        | undefined;

      return row ? mapCapabilityGrant(row) : null;
    },
    hasGrant(input: {
      capabilityId: string;
      agentId?: string | null;
      userId?: string | null;
    }): boolean {
      return this.findGrant(input) !== null;
    },
    revokeGrant(input: {
      capabilityId: string;
      agentId?: string | null;
      userId?: string | null;
    }): void {
      database
        .prepare(
          `
          DELETE FROM capability_grants
          WHERE capability_id = ?
            AND (
              (agent_id IS NOT NULL AND agent_id = ?) OR
              (user_id IS NOT NULL AND user_id = ?)
            )
        `
        )
        .run(input.capabilityId, input.agentId ?? null, input.userId ?? null);
    }
  };
}

export function createApprovalRequestRepository(database: DatabaseConnection) {
  return {
    create(input: {
      executionId?: string | null;
      requestedByUserId?: string | null;
      reason?: string | null;
      payloadJson?: string;
      capabilityId?: string | null;
      subjectAgentId?: string | null;
      subjectUserId?: string | null;
      payloadHash?: string | null;
      canonicalPayloadJson?: string | null;
    }): ApprovalRequestRecord {
      const id = randomUUID();

      database
        .prepare(
          `
          INSERT INTO approval_requests (
            id,
            execution_id,
            requested_by_user_id,
            status,
            reason,
            payload_json,
            capability_id,
            subject_agent_id,
            subject_user_id,
            payload_hash,
            canonical_payload_json
          )
          VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          id,
          input.executionId ?? null,
          input.requestedByUserId ?? null,
          input.reason ?? null,
          input.payloadJson ?? "{}",
          input.capabilityId ?? null,
          input.subjectAgentId ?? null,
          input.subjectUserId ?? null,
          input.payloadHash ?? null,
          input.canonicalPayloadJson ?? null
        );

      const approval = this.getById(id);

      if (!approval) {
        throw new Error("Failed to create approval request.");
      }

      return approval;
    },
    getById(id: string): ApprovalRequestRecord | null {
      const row = database
        .prepare(
          `
          SELECT
            id,
            execution_id,
            requested_by_user_id,
            status,
            reason,
            payload_json,
            resolved_by_user_id,
            created_at,
            resolved_at,
            capability_id,
            subject_agent_id,
            subject_user_id,
            payload_hash,
            canonical_payload_json,
            lease_token_hash,
            lease_issued_at,
            lease_used_at
          FROM approval_requests
          WHERE id = ?
        `
        )
        .get(id) as Parameters<typeof mapApprovalRequest>[0] | undefined;

      return row ? mapApprovalRequest(row) : null;
    },
    list(): ApprovalRequestRecord[] {
      return database
        .prepare(
          `
          SELECT
            id,
            execution_id,
            requested_by_user_id,
            status,
            reason,
            payload_json,
            resolved_by_user_id,
            created_at,
            resolved_at,
            capability_id,
            subject_agent_id,
            subject_user_id,
            payload_hash,
            canonical_payload_json,
            lease_token_hash,
            lease_issued_at,
            lease_used_at
          FROM approval_requests
          ORDER BY created_at DESC
        `
        )
        .all()
        .map((row) => mapApprovalRequest(row as Parameters<typeof mapApprovalRequest>[0]));
    },
    approve(input: {
      id: string;
      resolvedByUserId?: string | null;
      leaseTokenHash: string;
    }): ApprovalRequestRecord | null {
      database
        .prepare(
          `
          UPDATE approval_requests
          SET
            status = 'approved',
            resolved_by_user_id = ?,
            resolved_at = CURRENT_TIMESTAMP,
            lease_token_hash = ?,
            lease_issued_at = CURRENT_TIMESTAMP,
            lease_used_at = NULL
          WHERE id = ?
            AND status = 'pending'
        `
        )
        .run(input.resolvedByUserId ?? null, input.leaseTokenHash, input.id);

      return this.getById(input.id);
    },
    deny(input: {
      id: string;
      resolvedByUserId?: string | null;
    }): ApprovalRequestRecord | null {
      database
        .prepare(
          `
          UPDATE approval_requests
          SET
            status = 'rejected',
            resolved_by_user_id = ?,
            resolved_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND status = 'pending'
        `
        )
        .run(input.resolvedByUserId ?? null, input.id);

      return this.getById(input.id);
    },
    consumeLease(input: {
      id: string;
      leaseTokenHash: string;
      payloadHash: string;
    }): ApprovalRequestRecord | null {
      const result = database
        .prepare(
          `
          UPDATE approval_requests
          SET lease_used_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND status = 'approved'
            AND payload_hash = ?
            AND lease_token_hash = ?
            AND lease_used_at IS NULL
        `
        )
        .run(input.id, input.payloadHash, input.leaseTokenHash);

      if (result.changes === 0) {
        return null;
      }

      const approval = this.getById(input.id);

      return approval?.leaseUsedAt ? approval : null;
    }
  };
}

export function createAuditEventRepository(database: DatabaseConnection) {
  return {
    record(event: {
      actorUserId?: string | null;
      action: string;
      targetType?: string | null;
      targetId?: string | null;
      payloadJson?: string;
    }): string {
      const id = randomUUID();
      const payloadJson = redactPayloadJson(event.payloadJson ?? "{}");

      database
        .prepare(
          `
          INSERT INTO audit_events (
            id,
            actor_user_id,
            action,
            target_type,
            target_id,
            payload_json
          )
          VALUES (?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          id,
          event.actorUserId ?? null,
          event.action,
          event.targetType ?? null,
          event.targetId ?? null,
          payloadJson
        );

      return id;
    },
    list(limit = 100): AuditEventRecord[] {
      return database
        .prepare(
          `
          SELECT
            id,
            actor_user_id,
            action,
            target_type,
            target_id,
            payload_json,
            created_at
          FROM audit_events
          ORDER BY created_at DESC
          LIMIT ?
        `
        )
        .all(limit)
        .map((row) => mapAuditEvent(row as Parameters<typeof mapAuditEvent>[0]));
    }
  };
}

export function createAgentStateRepository(database: DatabaseConnection) {
  return {
    get(key: string): AgentStateRecord | null {
      const row = database
        .prepare(
          `
          SELECT key, value_json, updated_at
          FROM agent_state
          WHERE key = ?
        `
        )
        .get(key) as Parameters<typeof mapAgentState>[0] | undefined;

      return row ? mapAgentState(row) : null;
    },
    set(key: string, valueJson: string): AgentStateRecord {
      database
        .prepare(
          `
          INSERT INTO agent_state (key, value_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `
        )
        .run(key, valueJson, nowIso());

      const state = this.get(key);

      if (!state) {
        throw new Error("Failed to store agent state.");
      }

      return state;
    },
    list(): AgentStateRecord[] {
      return database
        .prepare(
          `
          SELECT key, value_json, updated_at
          FROM agent_state
          ORDER BY key ASC
        `
        )
        .all()
        .map((row) => mapAgentState(row as Parameters<typeof mapAgentState>[0]));
    }
  };
}

export function createRoutineRepository(database: DatabaseConnection) {
  return {
    upsert(input: {
      id: string;
      name: string;
      description?: string | null;
      stepsJson: string;
      scheduleJson?: string | null;
      enabled?: boolean;
    }): RoutineRecord {
      database
        .prepare(
          `
          INSERT INTO routines (
            id,
            name,
            description,
            steps_json,
            schedule_json,
            enabled,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            steps_json = excluded.steps_json,
            schedule_json = excluded.schedule_json,
            enabled = excluded.enabled,
            updated_at = excluded.updated_at
        `
        )
        .run(
          input.id,
          input.name,
          input.description ?? null,
          input.stepsJson,
          input.scheduleJson ?? null,
          input.enabled === false ? 0 : 1,
          nowIso()
        );

      const routine = this.getById(input.id);

      if (!routine) {
        throw new Error("Failed to upsert routine.");
      }

      return routine;
    },
    getById(id: string): RoutineRecord | null {
      const row = database
        .prepare(
          `
          SELECT
            id,
            name,
            description,
            steps_json,
            schedule_json,
            enabled,
            created_at,
            updated_at
          FROM routines
          WHERE id = ?
        `
        )
        .get(id) as Parameters<typeof mapRoutine>[0] | undefined;

      return row ? mapRoutine(row) : null;
    },
    list(): RoutineRecord[] {
      return database
        .prepare(
          `
          SELECT
            id,
            name,
            description,
            steps_json,
            schedule_json,
            enabled,
            created_at,
            updated_at
          FROM routines
          ORDER BY name ASC, id ASC
        `
        )
        .all()
        .map((row) => mapRoutine(row as Parameters<typeof mapRoutine>[0]));
    },
    setEnabled(id: string, enabled: boolean): RoutineRecord | null {
      database
        .prepare("UPDATE routines SET enabled = ?, updated_at = ? WHERE id = ?")
        .run(enabled ? 1 : 0, nowIso(), id);

      return this.getById(id);
    }
  };
}

export function createScheduledTaskRepository(database: DatabaseConnection) {
  return {
    create(input: {
      id?: string;
      name: string;
      routineId?: string | null;
      jobType?: string;
      inputJson?: string;
      scheduleJson: string;
      status?: ScheduledTaskStatus;
      nextRunAt?: string | null;
    }): ScheduledTaskRecord {
      const id = input.id ?? randomUUID();

      database
        .prepare(
          `
          INSERT INTO scheduled_tasks (
            id,
            name,
            routine_id,
            job_type,
            input_json,
            schedule_json,
            status,
            next_run_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          id,
          input.name,
          input.routineId ?? null,
          input.jobType ?? "routine.run",
          input.inputJson ?? "{}",
          input.scheduleJson,
          input.status ?? "active",
          input.nextRunAt ?? null,
          nowIso()
        );

      const task = this.getById(id);

      if (!task) {
        throw new Error("Failed to create scheduled task.");
      }

      return task;
    },
    getById(id: string): ScheduledTaskRecord | null {
      const row = database
        .prepare(
          `
          SELECT
            id,
            name,
            routine_id,
            job_type,
            input_json,
            schedule_json,
            status,
            next_run_at,
            last_run_at,
            created_at,
            updated_at
          FROM scheduled_tasks
          WHERE id = ?
        `
        )
        .get(id) as Parameters<typeof mapScheduledTask>[0] | undefined;

      return row ? mapScheduledTask(row) : null;
    },
    list(): ScheduledTaskRecord[] {
      return database
        .prepare(
          `
          SELECT
            id,
            name,
            routine_id,
            job_type,
            input_json,
            schedule_json,
            status,
            next_run_at,
            last_run_at,
            created_at,
            updated_at
          FROM scheduled_tasks
          ORDER BY next_run_at ASC, created_at ASC
        `
        )
        .all()
        .map((row) => mapScheduledTask(row as Parameters<typeof mapScheduledTask>[0]));
    },
    listDue(now = nowIso(), limit = 25): ScheduledTaskRecord[] {
      return database
        .prepare(
          `
          SELECT
            id,
            name,
            routine_id,
            job_type,
            input_json,
            schedule_json,
            status,
            next_run_at,
            last_run_at,
            created_at,
            updated_at
          FROM scheduled_tasks
          WHERE status = 'active'
            AND next_run_at IS NOT NULL
            AND next_run_at <= ?
          ORDER BY next_run_at ASC, created_at ASC
          LIMIT ?
        `
        )
        .all(now, limit)
        .map((row) => mapScheduledTask(row as Parameters<typeof mapScheduledTask>[0]));
    },
    markTriggered(input: {
      id: string;
      lastRunAt: string;
      nextRunAt?: string | null;
      status?: ScheduledTaskStatus;
    }): ScheduledTaskRecord | null {
      database
        .prepare(
          `
          UPDATE scheduled_tasks
          SET
            last_run_at = ?,
            next_run_at = ?,
            status = ?,
            updated_at = ?
          WHERE id = ?
        `
        )
        .run(
          input.lastRunAt,
          input.nextRunAt ?? null,
          input.status ?? (input.nextRunAt ? "active" : "completed"),
          nowIso(),
          input.id
        );

      return this.getById(input.id);
    },
    setStatus(id: string, status: ScheduledTaskStatus): ScheduledTaskRecord | null {
      database
        .prepare("UPDATE scheduled_tasks SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, nowIso(), id);

      return this.getById(id);
    }
  };
}

export function createJobRepository(database: DatabaseConnection) {
  return {
    enqueue(input: {
      type: string;
      routineId?: string | null;
      skillId?: string | null;
      inputJson?: string;
      maxAttempts?: number;
      availableAt?: string;
    }): JobRecord {
      const id = randomUUID();
      const availableAt = input.availableAt ?? nowIso();

      database
        .prepare(
          `
          INSERT INTO jobs (
            id,
            type,
            status,
            routine_id,
            skill_id,
            input_json,
            max_attempts,
            available_at,
            updated_at
          )
          VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          id,
          input.type,
          input.routineId ?? null,
          input.skillId ?? null,
          input.inputJson ?? "{}",
          input.maxAttempts ?? 3,
          availableAt,
          availableAt
        );

      const job = this.getById(id);

      if (!job) {
        throw new Error("Failed to enqueue job.");
      }

      return job;
    },
    getById(id: string): JobRecord | null {
      const row = database
        .prepare(
          `
          SELECT
            id,
            type,
            status,
            routine_id,
            skill_id,
            input_json,
            result_json,
            error_json,
            attempts,
            max_attempts,
            available_at,
            started_at,
            completed_at,
            created_at,
            updated_at
          FROM jobs
          WHERE id = ?
        `
        )
        .get(id) as Parameters<typeof mapJob>[0] | undefined;

      return row ? mapJob(row) : null;
    },
    list(input: { status?: JobStatus; limit?: number } = {}): JobRecord[] {
      if (input.status) {
        return database
          .prepare(
            `
            SELECT
              id,
              type,
              status,
              routine_id,
              skill_id,
              input_json,
              result_json,
              error_json,
              attempts,
              max_attempts,
              available_at,
              started_at,
              completed_at,
              created_at,
              updated_at
            FROM jobs
            WHERE status = ?
            ORDER BY created_at DESC
            LIMIT ?
          `
          )
          .all(input.status, input.limit ?? 100)
          .map((row) => mapJob(row as Parameters<typeof mapJob>[0]));
      }

      return database
        .prepare(
          `
          SELECT
            id,
            type,
            status,
            routine_id,
            skill_id,
            input_json,
            result_json,
            error_json,
            attempts,
            max_attempts,
            available_at,
            started_at,
            completed_at,
            created_at,
            updated_at
          FROM jobs
          ORDER BY created_at DESC
          LIMIT ?
        `
        )
        .all(input.limit ?? 100)
        .map((row) => mapJob(row as Parameters<typeof mapJob>[0]));
    },
    claimNext(now = nowIso()): JobRecord | null {
      database.exec("BEGIN IMMEDIATE;");

      try {
        const candidate = database
          .prepare(
            `
            SELECT id
            FROM jobs
            WHERE status = 'pending'
              AND available_at <= ?
            ORDER BY available_at ASC, created_at ASC
            LIMIT 1
          `
          )
          .get(now) as { id: string } | undefined;

        if (!candidate) {
          database.exec("COMMIT;");
          return null;
        }

        database
          .prepare(
            `
            UPDATE jobs
            SET
              status = 'running',
              attempts = attempts + 1,
              started_at = ?,
              updated_at = ?
            WHERE id = ?
              AND status = 'pending'
          `
          )
          .run(now, now, candidate.id);

        database.exec("COMMIT;");

        return this.getById(candidate.id);
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    },
    complete(id: string, resultJson = "{}"): JobRecord | null {
      const completedAt = nowIso();

      database
        .prepare(
          `
          UPDATE jobs
          SET
            status = 'completed',
            result_json = ?,
            completed_at = ?,
            updated_at = ?
          WHERE id = ?
        `
        )
        .run(resultJson, completedAt, completedAt, id);

      return this.getById(id);
    },
    fail(input: { id: string; errorJson: string; retryAt?: string | null }): JobRecord | null {
      const job = this.getById(input.id);
      const failedAt = nowIso();

      if (!job) {
        return null;
      }

      if (input.retryAt && job.attempts < job.maxAttempts) {
        database
          .prepare(
            `
            UPDATE jobs
            SET
              status = 'pending',
              error_json = ?,
              available_at = ?,
              started_at = NULL,
              updated_at = ?
            WHERE id = ?
          `
          )
          .run(input.errorJson, input.retryAt, failedAt, input.id);

        return this.getById(input.id);
      }

      database
        .prepare(
          `
          UPDATE jobs
          SET
            status = 'failed',
            error_json = ?,
            completed_at = ?,
            updated_at = ?
          WHERE id = ?
        `
        )
        .run(input.errorJson, failedAt, failedAt, input.id);

      return this.getById(input.id);
    },
    cancel(id: string): JobRecord | null {
      const cancelledAt = nowIso();

      database
        .prepare(
          `
          UPDATE jobs
          SET
            status = 'cancelled',
            completed_at = ?,
            updated_at = ?
          WHERE id = ?
            AND status IN ('pending', 'running')
        `
        )
        .run(cancelledAt, cancelledAt, id);

      return this.getById(id);
    },
    stats(): Record<JobStatus, number> {
      const stats: Record<JobStatus, number> = {
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0
      };

      for (const row of database
        .prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status")
        .all() as Array<{ status: JobStatus; count: number }>) {
        stats[row.status] = row.count;
      }

      return stats;
    }
  };
}

export function createJobLogRepository(database: DatabaseConnection) {
  return {
    record(input: {
      jobId: string;
      level?: JobLogLevel;
      message: string;
      metadataJson?: string;
    }): JobLogRecord {
      const id = randomUUID();

      database
        .prepare(
          `
          INSERT INTO job_logs (id, job_id, level, message, metadata_json)
          VALUES (?, ?, ?, ?, ?)
        `
        )
        .run(id, input.jobId, input.level ?? "info", input.message, input.metadataJson ?? "{}");

      const row = database
        .prepare(
          `
          SELECT id, job_id, level, message, metadata_json, created_at
          FROM job_logs
          WHERE id = ?
        `
        )
        .get(id) as Parameters<typeof mapJobLog>[0] | undefined;

      if (!row) {
        throw new Error("Failed to record job log.");
      }

      return mapJobLog(row);
    },
    listByJob(jobId: string): JobLogRecord[] {
      return database
        .prepare(
          `
          SELECT id, job_id, level, message, metadata_json, created_at
          FROM job_logs
          WHERE job_id = ?
          ORDER BY created_at ASC
        `
        )
        .all(jobId)
        .map((row) => mapJobLog(row as Parameters<typeof mapJobLog>[0]));
    }
  };
}

export function createSkillRepository(database: DatabaseConnection) {
  return {
    upsert(input: {
      id: string;
      name: string;
      description?: string | null;
      version: string;
      permissionsJson?: string;
      configJson?: string;
      enabled?: boolean;
    }): SkillRecord {
      database
        .prepare(
          `
          INSERT INTO skills (
            id,
            name,
            description,
            version,
            permissions_json,
            config_json,
            enabled,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            version = excluded.version,
            permissions_json = excluded.permissions_json,
            config_json = excluded.config_json,
            enabled = excluded.enabled,
            updated_at = excluded.updated_at
        `
        )
        .run(
          input.id,
          input.name,
          input.description ?? null,
          input.version,
          input.permissionsJson ?? "[]",
          input.configJson ?? "{}",
          input.enabled === false ? 0 : 1,
          nowIso()
        );

      const skill = this.getById(input.id);

      if (!skill) {
        throw new Error("Failed to upsert skill.");
      }

      return skill;
    },
    getById(id: string): SkillRecord | null {
      const row = database
        .prepare(
          `
          SELECT
            id,
            name,
            description,
            version,
            permissions_json,
            config_json,
            enabled,
            created_at,
            updated_at
          FROM skills
          WHERE id = ?
        `
        )
        .get(id) as Parameters<typeof mapSkill>[0] | undefined;

      return row ? mapSkill(row) : null;
    },
    list(): SkillRecord[] {
      return database
        .prepare(
          `
          SELECT
            id,
            name,
            description,
            version,
            permissions_json,
            config_json,
            enabled,
            created_at,
            updated_at
          FROM skills
          ORDER BY id ASC
        `
        )
        .all()
        .map((row) => mapSkill(row as Parameters<typeof mapSkill>[0]));
    },
    setEnabled(id: string, enabled: boolean): SkillRecord | null {
      database
        .prepare("UPDATE skills SET enabled = ?, updated_at = ? WHERE id = ?")
        .run(enabled ? 1 : 0, nowIso(), id);

      return this.getById(id);
    }
  };
}

export function createHeartbeatRepository(database: DatabaseConnection) {
  return {
    record(input: {
      status: HeartbeatEventRecord["status"];
      payloadJson?: string;
    }): HeartbeatEventRecord {
      const id = randomUUID();

      database
        .prepare(
          `
          INSERT INTO heartbeat_events (id, status, payload_json)
          VALUES (?, ?, ?)
        `
        )
        .run(id, input.status, input.payloadJson ?? "{}");

      const row = database
        .prepare(
          `
          SELECT id, status, payload_json, created_at
          FROM heartbeat_events
          WHERE id = ?
        `
        )
        .get(id) as Parameters<typeof mapHeartbeatEvent>[0] | undefined;

      if (!row) {
        throw new Error("Failed to record heartbeat event.");
      }

      return mapHeartbeatEvent(row);
    },
    list(limit = 100): HeartbeatEventRecord[] {
      return database
        .prepare(
          `
          SELECT id, status, payload_json, created_at
          FROM heartbeat_events
          ORDER BY created_at DESC
          LIMIT ?
        `
        )
        .all(limit)
        .map((row) => mapHeartbeatEvent(row as Parameters<typeof mapHeartbeatEvent>[0]));
    }
  };
}

function redactPayloadJson(payloadJson: string): string {
  try {
    return JSON.stringify(redactSensitiveValue(JSON.parse(payloadJson) as unknown));
  } catch {
    return redactSensitiveText(payloadJson);
  }
}

function mapAgent(row: {
  id: string;
  name: string;
  description: string | null;
  system_prompt: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
}): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    systemPrompt: row.system_prompt,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapThread(row: {
  id: string;
  agent_id: string | null;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
}): ThreadRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapMessage(row: {
  id: string;
  thread_id: string;
  role: MessageRecord["role"];
  content: string;
  metadata_json: string;
  created_at: string;
}): MessageRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    content: row.content,
    metadataJson: row.metadata_json,
    createdAt: row.created_at
  };
}

function mapExecution(row: {
  id: string;
  thread_id: string | null;
  agent_id: string | null;
  status: ExecutionRecord["status"];
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}): ExecutionRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    agentId: row.agent_id,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at
  };
}

function mapExecutionEvent(row: {
  id: string;
  execution_id: string;
  type: string;
  payload_json: string;
  created_at: string;
}): ExecutionEventRecord {
  return {
    id: row.id,
    executionId: row.execution_id,
    type: row.type,
    payloadJson: row.payload_json,
    createdAt: row.created_at
  };
}

function mapDocument(row: {
  id: string;
  title: string;
  source_uri: string | null;
  mime_type: string | null;
  content_hash: string | null;
  created_at: string;
  updated_at: string;
}): DocumentRecord {
  return {
    id: row.id,
    title: row.title,
    sourceUri: row.source_uri,
    mimeType: row.mime_type,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapDocumentChunkSearch(row: {
  chunk_id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  token_count: number | null;
  metadata_json: string;
  document_title: string;
  source_uri: string | null;
  mime_type: string | null;
  embedding_provider: string | null;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  embedding_json: string | null;
}): DocumentChunkSearchRecord {
  return {
    chunkId: row.chunk_id,
    documentId: row.document_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    tokenCount: row.token_count,
    metadataJson: row.metadata_json,
    documentTitle: row.document_title,
    sourceUri: row.source_uri,
    mimeType: row.mime_type,
    embeddingProvider: row.embedding_provider,
    embeddingModel: row.embedding_model,
    embeddingDimensions: row.embedding_dimensions,
    embeddingJson: row.embedding_json
  };
}

function mapCapability(row: {
  id: string;
  name: string;
  description: string | null;
  version: string;
  risk: CapabilityRisk;
  effects_json: string;
  requires_approval: 0 | 1;
  created_at: string;
}): CapabilityRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    risk: row.risk,
    effectsJson: row.effects_json,
    requiresApproval: row.requires_approval === 1,
    createdAt: row.created_at
  };
}

function mapCapabilityGrant(row: {
  id: string;
  capability_id: string;
  agent_id: string | null;
  user_id: string | null;
  granted_by_user_id: string | null;
  created_at: string;
}): CapabilityGrantRecord {
  return {
    id: row.id,
    capabilityId: row.capability_id,
    agentId: row.agent_id,
    userId: row.user_id,
    grantedByUserId: row.granted_by_user_id,
    createdAt: row.created_at
  };
}

function mapApprovalRequest(row: {
  id: string;
  execution_id: string | null;
  requested_by_user_id: string | null;
  status: ApprovalRequestRecord["status"];
  reason: string | null;
  payload_json: string;
  resolved_by_user_id: string | null;
  created_at: string;
  resolved_at: string | null;
  capability_id: string | null;
  subject_agent_id: string | null;
  subject_user_id: string | null;
  payload_hash: string | null;
  canonical_payload_json: string | null;
  lease_token_hash: string | null;
  lease_issued_at: string | null;
  lease_used_at: string | null;
}): ApprovalRequestRecord {
  return {
    id: row.id,
    executionId: row.execution_id,
    requestedByUserId: row.requested_by_user_id,
    status: row.status,
    reason: row.reason,
    payloadJson: row.payload_json,
    resolvedByUserId: row.resolved_by_user_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    capabilityId: row.capability_id,
    subjectAgentId: row.subject_agent_id,
    subjectUserId: row.subject_user_id,
    payloadHash: row.payload_hash,
    canonicalPayloadJson: row.canonical_payload_json,
    leaseTokenHash: row.lease_token_hash,
    leaseIssuedAt: row.lease_issued_at,
    leaseUsedAt: row.lease_used_at
  };
}

function mapAuditEvent(row: {
  id: string;
  actor_user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  payload_json: string;
  created_at: string;
}): AuditEventRecord {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    payloadJson: row.payload_json,
    createdAt: row.created_at
  };
}

function mapAgentState(row: {
  key: string;
  value_json: string;
  updated_at: string;
}): AgentStateRecord {
  return {
    key: row.key,
    valueJson: row.value_json,
    updatedAt: row.updated_at
  };
}

function mapRoutine(row: {
  id: string;
  name: string;
  description: string | null;
  steps_json: string;
  schedule_json: string | null;
  enabled: 0 | 1;
  created_at: string;
  updated_at: string;
}): RoutineRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    stepsJson: row.steps_json,
    scheduleJson: row.schedule_json,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapScheduledTask(row: {
  id: string;
  name: string;
  routine_id: string | null;
  job_type: string;
  input_json: string;
  schedule_json: string;
  status: ScheduledTaskStatus;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}): ScheduledTaskRecord {
  return {
    id: row.id,
    name: row.name,
    routineId: row.routine_id,
    jobType: row.job_type,
    inputJson: row.input_json,
    scheduleJson: row.schedule_json,
    status: row.status,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapJob(row: {
  id: string;
  type: string;
  status: JobStatus;
  routine_id: string | null;
  skill_id: string | null;
  input_json: string;
  result_json: string | null;
  error_json: string | null;
  attempts: number;
  max_attempts: number;
  available_at: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}): JobRecord {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    routineId: row.routine_id,
    skillId: row.skill_id,
    inputJson: row.input_json,
    resultJson: row.result_json,
    errorJson: row.error_json,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapJobLog(row: {
  id: string;
  job_id: string;
  level: JobLogLevel;
  message: string;
  metadata_json: string;
  created_at: string;
}): JobLogRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    level: row.level,
    message: row.message,
    metadataJson: row.metadata_json,
    createdAt: row.created_at
  };
}

function mapSkill(row: {
  id: string;
  name: string;
  description: string | null;
  version: string;
  permissions_json: string;
  config_json: string;
  enabled: 0 | 1;
  created_at: string;
  updated_at: string;
}): SkillRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    permissionsJson: row.permissions_json,
    configJson: row.config_json,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapHeartbeatEvent(row: {
  id: string;
  status: HeartbeatEventRecord["status"];
  payload_json: string;
  created_at: string;
}): HeartbeatEventRecord {
  return {
    id: row.id,
    status: row.status,
    payloadJson: row.payload_json,
    createdAt: row.created_at
  };
}

function defaultWorkspaceRoot(): string {
  const configuredRoot = loadConfig().workspace.root;

  if (isAbsolute(configuredRoot)) {
    return resolve(configuredRoot);
  }

  const monorepoRoot = findMonorepoRoot(process.cwd());

  return resolve(monorepoRoot ?? process.cwd(), configuredRoot);
}

function findMonorepoRoot(start: string): string | null {
  let current = resolve(start);

  while (true) {
    if (existsSync(resolve(current, "pnpm-workspace.yaml"))) {
      return current;
    }

    const parent = dirname(current);

    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function readMigrations(): Array<{ id: string; sql: string }> {
  const migrationsDir = new URL("../migrations", import.meta.url);

  return readdirSync(migrationsDir)
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort()
    .map((fileName) => ({
      id: fileName,
      sql: readFileSync(new URL(fileName, `${migrationsDir.href}/`), "utf8")
    }));
}
