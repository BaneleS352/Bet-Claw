import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  createAuditEventRepository,
  createSettingsRepository,
  initializeDatabase,
  migrate,
  openDatabase
} from "./index.js";

const phase3Tables = [
  "users",
  "agents",
  "threads",
  "messages",
  "executions",
  "execution_events",
  "documents",
  "document_chunks",
  "document_embeddings",
  "capabilities",
  "capability_grants",
  "approval_requests",
  "audit_events",
  "settings",
  "agent_state",
  "routines",
  "scheduled_tasks",
  "jobs",
  "job_logs",
  "skills",
  "heartbeat_events"
];

describe("db", () => {
  it("runs migrations and stores settings", () => {
    const database = openDatabase(":memory:");

    try {
      const result = migrate(database);
      const repository = createSettingsRepository(database);

      repository.set("phase", JSON.stringify(3));

      expect(result.applied).toEqual([
        "0001_initial.sql",
        "0002_phase3_schema.sql",
        "0003_document_source_unique.sql",
        "0004_capability_descriptors.sql",
        "0005_approval_leases.sql",
        "0006_agent_os.sql"
      ]);
      expect(repository.get("phase")).toBe("3");
    } finally {
      database.close();
    }
  });

  it("stores audit events with safe JSON payloads", () => {
    const database = openDatabase(":memory:");

    try {
      migrate(database);
      const repository = createAuditEventRepository(database);
      const id = repository.record({
        action: "llm.chat.error",
        targetType: "llm",
        payloadJson: JSON.stringify({
          name: "Error",
          message: "Bearer sk-local-secret failed",
          llm: {
            apiKey: "abc123"
          }
        })
      });
      const row = database.prepare("SELECT action, payload_json FROM audit_events WHERE id = ?").get(id) as
        | { action: string; payload_json: string }
        | undefined;

      expect(row).toEqual({
        action: "llm.chat.error",
        payload_json: JSON.stringify({
          name: "Error",
          message: "Bearer [REDACTED] failed",
          llm: {
            apiKey: "[REDACTED]"
          }
        })
      });
      expect(row?.payload_json).not.toContain("sk-local-secret");
      expect(row?.payload_json).not.toContain("abc123");
    } finally {
      database.close();
    }
  });

  it("creates every Phase 3 table from migrations", () => {
    const database = openDatabase(":memory:");

    try {
      migrate(database);

      expect(listTables(database)).toEqual(expect.arrayContaining(phase3Tables));
      expect(listTables(database)).not.toEqual(expect.arrayContaining(["app_metadata", "conversations"]));
    } finally {
      database.close();
    }
  });

  it("is repeatable and skips already-applied migrations", () => {
    const database = openDatabase(":memory:");

    try {
      expect(migrate(database).applied).toEqual([
        "0001_initial.sql",
        "0002_phase3_schema.sql",
        "0003_document_source_unique.sql",
        "0004_capability_descriptors.sql",
        "0005_approval_leases.sql",
        "0006_agent_os.sql"
      ]);
      expect(migrate(database).applied).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("initializes a temporary SQLite DB on first run", () => {
    const cwd = join(tmpdir(), `openclaw-db-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    const dbPath = join(cwd, "test.sqlite");

    try {
      const { database, migrations } = initializeDatabase(dbPath);

      try {
        expect(migrations.applied).toEqual([
          "0001_initial.sql",
          "0002_phase3_schema.sql",
          "0003_document_source_unique.sql",
          "0004_capability_descriptors.sql",
          "0005_approval_leases.sql",
          "0006_agent_os.sql"
        ]);
        expect(listTables(database)).toEqual(expect.arrayContaining(phase3Tables));
      } finally {
        database.close();
      }

      const secondRun = initializeDatabase(dbPath);

      try {
        expect(secondRun.migrations.applied).toEqual([]);
      } finally {
        secondRun.database.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

function listTables(database: ReturnType<typeof openDatabase>): string[] {
  return database
    .prepare(
      `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `
    )
    .all()
    .map((row) => String((row as { name: unknown }).name));
}
