import { describe, expect, it } from "vitest";

import { migrate, openDatabase } from "@openclaw/db";

import {
  CapabilityApprovalRequiredError,
  CapabilityDeniedError,
  ApprovalRequestNotPendingError,
  createCapabilityHost,
  initialCapabilityDescriptors
} from "./index.js";

describe("capability host", () => {
  it("declares the initial Phase 8 capabilities", () => {
    expect(initialCapabilityDescriptors.map((descriptor) => descriptor.id)).toEqual([
      "documents.search",
      "documents.read",
      "documents.ingest",
      "memory.search",
      "file.read",
      "file.write",
      "settings.update"
    ]);
    expect(initialCapabilityDescriptors.map((descriptor) => descriptor.id)).not.toEqual(
      expect.arrayContaining(["shell.execute", "plugins.run"])
    );
  });

  it("executes granted read/search capabilities and writes audit events", async () => {
    const database = openDatabase(":memory:");

    try {
      migrate(database);
      createAgent(database, "default");
      const host = createCapabilityHost({ database });
      host.ensureDefaultGrants({ agentId: "default" });

      const result = await host.execute({
        capabilityId: "memory.search",
        input: {
          query: "security"
        },
        subject: {
          agentId: "default"
        },
        run(input) {
          return input;
        }
      });
      const actions = auditActions(database);

      expect(result).toEqual({ query: "security" });
      expect(actions).toEqual(
        expect.arrayContaining(["capability.call.started", "capability.call.completed"])
      );
    } finally {
      database.close();
    }
  });

  it("denies execution when a grant is missing", async () => {
    const database = openDatabase(":memory:");
    let called = false;

    try {
      migrate(database);
      createAgent(database, "default");
      const host = createCapabilityHost({ database });
      host.ensureDefaultGrants({ agentId: "default" });
      database.prepare("DELETE FROM capability_grants WHERE capability_id = ?").run("memory.search");

      await expect(
        host.execute({
          capabilityId: "memory.search",
          input: {
            query: "security"
          },
          subject: {
            agentId: "default"
          },
          run() {
            called = true;
          }
        })
      ).rejects.toBeInstanceOf(CapabilityDeniedError);

      expect(called).toBe(false);
      expect(auditActions(database)).toContain("capability.call.denied");
    } finally {
      database.close();
    }
  });

  it("requires approval for write and settings mutations", async () => {
    const database = openDatabase(":memory:");
    let called = false;

    try {
      migrate(database);
      createAgent(database, "default");
      const host = createCapabilityHost({ database });
      host.ensureDefaultGrants({ agentId: "default" });

      const pending = await host
        .execute({
          capabilityId: "settings.update",
          input: {
            key: "theme",
            value: "dark"
          },
          subject: {
            agentId: "default"
          },
          run() {
            called = true;
            return "updated";
          }
        })
        .catch((error: unknown) => error);

      expect(pending).toBeInstanceOf(CapabilityApprovalRequiredError);
      expect(called).toBe(false);
      expect(countRows(database, "approval_requests")).toBe(1);
      expect(auditActions(database)).toContain("capability.call.approval_required");

      const decision = host.approveRequest((pending as CapabilityApprovalRequiredError).approvalRequestId);

      await expect(
        host.execute({
          capabilityId: "settings.update",
          input: {
            key: "theme",
            value: "dark"
          },
          subject: {
            agentId: "default"
          },
          approval: {
            requestId: decision.approval.id,
            leaseToken: decision.leaseToken
          },
          run() {
            called = true;
            return "updated";
          }
        })
      ).resolves.toBe("updated");

      expect(called).toBe(true);
      expect(auditActions(database)).toEqual(
        expect.arrayContaining([
          "approval.request.approved",
          "approval.lease.consumed",
          "capability.call.completed"
        ])
      );
    } finally {
      database.close();
    }
  });

  it("redacts sensitive capability inputs from audit events", async () => {
    const database = openDatabase(":memory:");

    try {
      migrate(database);
      createAgent(database, "default");
      const host = createCapabilityHost({ database });
      host.ensureDefaultGrants({ agentId: "default" });

      await expect(
        host.execute({
          capabilityId: "settings.update",
          input: {
            key: "app.config",
            value: {
              llm: {
                apiKey: "sk-local-secret"
              }
            }
          },
          subject: {
            agentId: "default"
          },
          run() {
            return "updated";
          }
        })
      ).rejects.toBeInstanceOf(CapabilityApprovalRequiredError);

      const payloads = database
        .prepare("SELECT payload_json FROM audit_events")
        .all()
        .map((row) => String((row as { payload_json: unknown }).payload_json));

      expect(payloads.join("\n")).toContain("[REDACTED]");
      expect(payloads.join("\n")).not.toContain("sk-local-secret");
    } finally {
      database.close();
    }
  });

  it("does not let file.write run without approval", async () => {
    const database = openDatabase(":memory:");
    let called = false;

    try {
      migrate(database);
      createAgent(database, "default");
      const host = createCapabilityHost({ database });
      host.ensureDefaultGrants({ agentId: "default" });

      await expect(
        host.execute({
          capabilityId: "file.write",
          input: {
            path: "notes/a.txt",
            content: "approved content"
          },
          subject: {
            agentId: "default"
          },
          run() {
            called = true;
          }
        })
      ).rejects.toBeInstanceOf(CapabilityApprovalRequiredError);

      expect(called).toBe(false);
    } finally {
      database.close();
    }
  });

  it("invalidates approval when input changes and consumes a lease once", async () => {
    const database = openDatabase(":memory:");

    try {
      migrate(database);
      createAgent(database, "default");
      const host = createCapabilityHost({ database });
      host.ensureDefaultGrants({ agentId: "default" });
      const pending = await host
        .execute({
          capabilityId: "file.write",
          input: {
            path: "notes/a.txt",
            content: "approved content"
          },
          subject: {
            agentId: "default"
          },
          run() {
            return "written";
          }
        })
        .catch((error: unknown) => error);

      expect(pending).toBeInstanceOf(CapabilityApprovalRequiredError);
      const decision = host.approveRequest((pending as CapabilityApprovalRequiredError).approvalRequestId);
      const approval = {
        requestId: decision.approval.id,
        leaseToken: decision.leaseToken
      };

      await expect(
        host.execute({
          capabilityId: "file.write",
          input: {
            path: "notes/a.txt",
            content: "changed content"
          },
          subject: {
            agentId: "default"
          },
          approval,
          run() {
            return "written";
          }
        })
      ).rejects.toBeInstanceOf(CapabilityDeniedError);

      await expect(
        host.execute({
          capabilityId: "file.write",
          input: {
            path: "notes/a.txt",
            content: "approved content"
          },
          subject: {
            agentId: "default"
          },
          approval,
          run() {
            return "written";
          }
        })
      ).resolves.toBe("written");

      await expect(
        host.execute({
          capabilityId: "file.write",
          input: {
            path: "notes/a.txt",
            content: "approved content"
          },
          subject: {
            agentId: "default"
          },
          approval,
          run() {
            return "written";
          }
        })
      ).rejects.toBeInstanceOf(CapabilityDeniedError);
    } finally {
      database.close();
    }
  });

  it("denies pending approval requests", () => {
    const database = openDatabase(":memory:");

    try {
      migrate(database);
      createAgent(database, "default");
      const host = createCapabilityHost({ database });
      host.ensureDefaultGrants({ agentId: "default" });
      database
        .prepare(
          `
          INSERT INTO approval_requests (id, status, payload_json)
          VALUES ('approval-1', 'pending', '{}')
        `
        )
        .run();

      const denied = host.denyRequest("approval-1");

      expect(denied.status).toBe("rejected");
      expect(auditActions(database)).toContain("approval.request.denied");
      expect(() => host.approveRequest("approval-1")).toThrow(ApprovalRequestNotPendingError);
    } finally {
      database.close();
    }
  });
});

function createAgent(database: ReturnType<typeof openDatabase>, id: string): void {
  database
    .prepare(
      `
      INSERT INTO agents (id, name)
      VALUES (?, ?)
    `
    )
    .run(id, id);
}

function auditActions(database: ReturnType<typeof openDatabase>): string[] {
  return database
    .prepare("SELECT action FROM audit_events ORDER BY created_at ASC")
    .all()
    .map((row) => String((row as { action: unknown }).action));
}

function countRows(database: ReturnType<typeof openDatabase>, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };

  return row.count;
}
