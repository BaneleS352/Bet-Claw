import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { migrate, openDatabase } from "@openclaw/db";
import type { ChatMessage, LlmProvider } from "@openclaw/llm";
import type { AppConfig } from "@openclaw/shared";

import { buildServer } from "./server.js";

const config: AppConfig = {
  server: {
    host: "127.0.0.1",
    port: 0
  },
  llm: {
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "test",
    chatModel: "test-chat",
    embeddingModel: "test-embedding"
  },
  network: {
    mode: "offline",
    allowLoopback: true,
    allowedHosts: ["127.0.0.1", "localhost"]
  },
  workspace: {
    root: "."
  },
  agentOs: {
    enabled: false,
    heartbeatIntervalMs: 30_000,
    jobsPerHeartbeat: 5,
    jobRetryDelayMs: 1_000
  }
};

const llmProvider: LlmProvider = {
  async *streamChat() {
    yield { role: "assistant", content: "Hel" };
    yield { content: "lo" };
    yield { done: true };
  },
  async embed(input) {
    return input.map((_item, index) => [index, index + 1]);
  }
};

describe("API server", () => {
  it("exposes GET /health", async () => {
    const server = await buildServer({
      config,
      llmProvider
    });

    try {
      const response = await server.inject({
        method: "GET",
        url: "/health"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        service: "openclaw-api"
      });
    } finally {
      await server.close();
    }
  });

  it("refuses non-allowlisted outbound HTTP", async () => {
    const server = await buildServer({
      config,
      llmProvider
    });

    try {
      const outboundFetch = (server as typeof server & { outboundFetch: typeof fetch }).outboundFetch;

      await expect(outboundFetch("https://example.com")).rejects.toThrow(
        /blocked by offline network policy/
      );
      await expect(fetch("https://example.com")).rejects.toThrow(/blocked by offline network policy/);
    } finally {
      await server.close();
    }
  });

  it("streams chat deltas to the caller", async () => {
    const server = await buildServer({
      config,
      llmProvider
    });

    try {
      const response = await server.inject({
        method: "POST",
        url: "/chat/stream",
        payload: {
          messages: [{ role: "user", content: "Hi" }]
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.payload).toContain('data: {"role":"assistant","content":"Hel"}');
      expect(response.payload).toContain('data: {"content":"lo"}');
      expect(response.payload).toContain('data: {"done":true}');
    } finally {
      await server.close();
    }
  });

  it("returns embeddings through the configured provider", async () => {
    const server = await buildServer({
      config,
      llmProvider
    });

    try {
      const response = await server.inject({
        method: "POST",
        url: "/embeddings",
        payload: {
          input: ["one", "two"]
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        embeddings: [
          [0, 1],
          [1, 2]
        ]
      });
    } finally {
      await server.close();
    }
  });

  it("stores redacted LLM errors safely", async () => {
    const database = openDatabase(":memory:");
    migrate(database);

    const failingProvider: LlmProvider = {
      async *streamChat() {
        yield await Promise.reject(new Error("Bearer sk-super-secret failed"));
      },
      async embed() {
        throw new Error("api_key=secret failed");
      }
    };
    const server = await buildServer({
      config,
      database,
      llmProvider: failingProvider
    });

    try {
      const response = await server.inject({
        method: "POST",
        url: "/chat/stream",
        payload: {
          messages: [{ role: "user", content: "Hi" }]
        }
      });
      const row = database
        .prepare("SELECT action, payload_json FROM audit_events WHERE action = ?")
        .get("llm.chat.error") as { action: string; payload_json: string } | undefined;

      expect(response.statusCode).toBe(200);
      expect(response.payload).toContain("event: error");
      expect(response.payload).not.toContain("sk-super-secret");
      expect(row?.payload_json).not.toContain("sk-super-secret");
      expect(row?.payload_json).toContain("[REDACTED]");
    } finally {
      await server.close();
      database.close();
    }
  });

  it("runs chat, streams to the caller, and persists runtime records", async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    const server = await buildServer({
      config,
      database,
      llmProvider
    });

    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/chat",
        payload: {
          message: "Hello local model"
        }
      });
      const events = parseSse(response.payload);
      const meta = events.find((event) => event.event === "meta");
      const done = events.find((event) => event.event === "done");

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "delta", data: { content: "Hel" } }),
          expect.objectContaining({ event: "delta", data: { content: "lo" } })
        ])
      );
      expect(meta?.data).toMatchObject({
        agentId: "default"
      });
      expect(done?.data).toMatchObject({
        threadId: meta?.data.threadId,
        executionId: meta?.data.executionId
      });

      const messagesResponse = await server.inject({
        method: "GET",
        url: `/api/threads/${String(meta?.data.threadId)}/messages`
      });
      const executionEventsResponse = await server.inject({
        method: "GET",
        url: `/api/executions/${String(meta?.data.executionId)}/events`
      });
      const threadsResponse = await server.inject({
        method: "GET",
        url: "/api/threads"
      });
      const auditRows = database
        .prepare("SELECT action FROM audit_events ORDER BY created_at ASC")
        .all()
        .map((row) => String((row as { action: unknown }).action));
      const executionRow = database
        .prepare("SELECT status FROM executions WHERE id = ?")
        .get(String(meta?.data.executionId)) as { status: string } | undefined;

      expect(threadsResponse.json().threads).toHaveLength(1);
      expect(messagesResponse.json().messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "Hello local model" }),
          expect.objectContaining({ role: "assistant", content: "Hello" })
        ])
      );
      expect(executionEventsResponse.json().events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "chat.started" }),
          expect.objectContaining({ type: "assistant.delta" }),
          expect.objectContaining({ type: "chat.completed" })
        ])
      );
      expect(executionRow?.status).toBe("completed");
      expect(auditRows).toEqual(expect.arrayContaining(["chat.run.started", "chat.run.completed"]));
    } finally {
      await server.close();
      database.close();
    }
  });

  it("exposes Agent OS routines, jobs, skills, and manual heartbeat processing", async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    const server = await buildServer({
      config,
      database,
      llmProvider
    });

    try {
      const skillsResponse = await server.inject({
        method: "GET",
        url: "/api/skills"
      });
      const routinesResponse = await server.inject({
        method: "GET",
        url: "/api/routines"
      });
      const runResponse = await server.inject({
        method: "POST",
        url: "/api/routines/routine.daily-planning/run",
        payload: {
          input: {
            priorities: ["Check scheduler"]
          }
        }
      });
      const jobId = String(runResponse.json().job.id);
      const processResponse = await server.inject({
        method: "POST",
        url: "/api/jobs/process",
        payload: {
          limit: 1
        }
      });
      const logsResponse = await server.inject({
        method: "GET",
        url: `/api/jobs/${jobId}/logs`
      });
      const heartbeatResponse = await server.inject({
        method: "POST",
        url: "/api/heartbeat/pulse"
      });
      const statusResponse = await server.inject({
        method: "GET",
        url: "/api/agent-os/status"
      });

      expect(skillsResponse.json().skills).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "planning.daily" })])
      );
      expect(routinesResponse.json().routines).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "routine.daily-planning" })])
      );
      expect(runResponse.statusCode).toBe(200);
      expect(processResponse.json().processed[0].job).toMatchObject({
        id: jobId,
        status: "completed"
      });
      expect(logsResponse.json().logs).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: "job.completed" })])
      );
      expect(heartbeatResponse.json().heartbeat.status).toBe("ok");
      expect(statusResponse.json().jobs.completed).toBe(1);
    } finally {
      await server.close();
      database.close();
    }
  });

  it("retrieves local documents, streams citations, and records retrieved chunk IDs", async () => {
    const workspace = join(tmpdir(), `openclaw-api-rag-${Date.now()}`);
    const policies = join(workspace, "policies");
    mkdirSync(policies, { recursive: true });
    writeFileSync(
      join(policies, "security.md"),
      "# Security\nAccess to production requires a local approval record."
    );
    const database = openDatabase(":memory:");
    migrate(database);
    const seenChatMessages: ChatMessage[][] = [];
    const ragProvider: LlmProvider = {
      async *streamChat(request) {
        seenChatMessages.push(request.messages);
        yield { role: "assistant", content: "Access requires local approval." };
        yield { done: true };
      },
      async embed(input) {
        return input.map((item) => {
          const normalized = item.toLowerCase();

          return [
            normalized.includes("security") || normalized.includes("access") ? 1 : 0,
            normalized.includes("quarter") || normalized.includes("q1") ? 1 : 0,
            0.1
          ];
        });
      }
    };
    const server = await buildServer({
      config: {
        ...config,
        workspace: {
          root: workspace
        }
      },
      database,
      llmProvider: ragProvider
    });

    try {
      await ingestWithApproval(server, "policies");

      const response = await server.inject({
        method: "POST",
        url: "/api/chat",
        payload: {
          message: "What is the security access rule?"
        }
      });
      const events = parseSse(response.payload);
      const assistantText = events
        .filter((event) => event.event === "delta")
        .map((event) => String(event.data.content ?? ""))
        .join("");
      const done = events.find((event) => event.event === "done");
      const executionEventsResponse = await server.inject({
        method: "GET",
        url: `/api/executions/${String(done?.data.executionId)}/events`
      });
      const retrievalEvent = (
        executionEventsResponse.json() as {
          events: Array<{ type: string; payloadJson: string }>;
        }
      ).events.find((event) => event.type === "retrieval.completed");
      const retrievalPayload = JSON.parse(retrievalEvent?.payloadJson ?? "{}") as {
        citations?: string[];
        retrievedChunkIds?: string[];
      };
      const systemMessage = seenChatMessages[0]?.find((message) => message.role === "system")?.content ?? "";

      expect(response.statusCode).toBe(200);
      expect(assistantText).toContain("Access requires local approval.");
      expect(assistantText).toContain("Sources:\n- workspace/policies/security.md");
      expect(done?.data.citations).toEqual(["workspace/policies/security.md"]);
      expect(retrievalPayload.citations).toEqual(["workspace/policies/security.md"]);
      expect(retrievalPayload.retrievedChunkIds?.length).toBeGreaterThan(0);
      expect(systemMessage).toContain("workspace/policies/security.md");
      expect(systemMessage).toContain("Access to production requires a local approval record.");
      expect(systemMessage).not.toContain(workspace);
    } finally {
      await server.close();
      database.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("redacts secrets before model context and audit persistence", async () => {
    const workspace = join(tmpdir(), `openclaw-api-redaction-${Date.now()}`);
    const docs = join(workspace, "docs");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "security.md"), "The fallback token is api_key=abc123 and Bearer sk-local-secret.");
    const database = openDatabase(":memory:");
    migrate(database);
    const seenChatMessages: ChatMessage[][] = [];
    const redactionProvider: LlmProvider = {
      async *streamChat(request) {
        seenChatMessages.push(request.messages);
        yield { role: "assistant", content: "Redacted." };
        yield { done: true };
      },
      async embed(input) {
        return input.map((item) => [
          item.toLowerCase().includes("token") || item.toLowerCase().includes("security") ? 1 : 0,
          0.1
        ]);
      }
    };
    const server = await buildServer({
      config: {
        ...config,
        workspace: {
          root: workspace
        }
      },
      database,
      llmProvider: redactionProvider
    });

    try {
      await ingestWithApproval(server, "docs");

      const response = await server.inject({
        method: "POST",
        url: "/api/chat",
        payload: {
          message: "Find token api_key=abc123 Bearer sk-local-secret"
        }
      });
      const modelContext = JSON.stringify(seenChatMessages);
      const auditPayloads = database
        .prepare("SELECT payload_json FROM audit_events")
        .all()
        .map((row) => String((row as { payload_json: unknown }).payload_json))
        .join("\n");

      expect(response.statusCode).toBe(200);
      expect(modelContext).toContain("[REDACTED]");
      expect(modelContext).not.toContain("abc123");
      expect(modelContext).not.toContain("sk-local-secret");
      expect(auditPayloads).toContain("[REDACTED]");
      expect(auditPayloads).not.toContain("abc123");
      expect(auditPayloads).not.toContain("sk-local-secret");
    } finally {
      await server.close();
      database.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("denies chat retrieval when the memory search grant is missing", async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    let calledModel = false;
    const guardedProvider: LlmProvider = {
      async *streamChat() {
        calledModel = true;
        yield { content: "should not run" };
      },
      async embed(input) {
        return input.map(() => [1, 0]);
      }
    };
    const server = await buildServer({
      config,
      database,
      llmProvider: guardedProvider
    });

    try {
      database.prepare("DELETE FROM capability_grants WHERE capability_id = ?").run("memory.search");

      const response = await server.inject({
        method: "POST",
        url: "/api/chat",
        payload: {
          message: "Search memory"
        }
      });
      const events = parseSse(response.payload);
      const meta = events.find((event) => event.event === "meta");
      const error = events.find((event) => event.event === "error");
      const executionRow = database
        .prepare("SELECT status FROM executions WHERE id = ?")
        .get(String(meta?.data.executionId)) as { status: string } | undefined;
      const capabilityAudit = database
        .prepare("SELECT action, payload_json FROM audit_events WHERE action = ?")
        .get("capability.call.denied") as { action: string; payload_json: string } | undefined;

      expect(response.statusCode).toBe(200);
      expect(calledModel).toBe(false);
      expect(error?.data).toMatchObject({
        name: "CapabilityDeniedError"
      });
      expect(executionRow?.status).toBe("failed");
      expect(capabilityAudit?.payload_json).toContain("missing_grant");
    } finally {
      await server.close();
      database.close();
    }
  });

  it("ingests a workspace folder through the memory API", async () => {
    const workspace = join(tmpdir(), `openclaw-api-memory-${Date.now()}`);
    const docs = join(workspace, "docs");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "guide.txt"), "Local documents can become memory.");
    const database = openDatabase(":memory:");
    migrate(database);
    const server = await buildServer({
      config: {
        ...config,
        workspace: {
          root: workspace
        }
      },
      database,
      llmProvider
    });

    try {
      const response = await ingestWithApproval(server, "docs");
      const body = response.json() as {
        scanned: number;
        ingested: Array<{ status: string; chunks: number }>;
      };
      const auditRows = database
        .prepare("SELECT action FROM audit_events WHERE action = ?")
        .all("memory.ingest.completed");
      const capabilityAuditRows = database
        .prepare("SELECT action FROM audit_events WHERE target_type = ? AND target_id = ?")
        .all("capability", "documents.ingest");
      const documentsResponse = await server.inject({
        method: "GET",
        url: "/api/documents"
      });

      expect(response.statusCode).toBe(200);
      expect(body.scanned).toBe(1);
      expect(body.ingested[0]).toMatchObject({ status: "created", chunks: 1 });
      expect(documentsResponse.statusCode).toBe(200);
      expect(documentsResponse.json().documents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title: "guide.txt",
            chunkCount: 1
          })
        ])
      );
      expect(countRows(database, "documents")).toBe(1);
      expect(countRows(database, "document_chunks")).toBe(1);
      expect(countRows(database, "document_embeddings")).toBe(1);
      expect(auditRows).toHaveLength(1);
      expect(
        capabilityAuditRows.map((row) => String((row as { action: unknown }).action))
      ).toEqual(expect.arrayContaining(["capability.call.started", "capability.call.completed"]));
    } finally {
      await server.close();
      database.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects memory ingestion outside the configured workspace", async () => {
    const workspace = join(tmpdir(), `openclaw-api-memory-${Date.now()}`);
    const outside = join(tmpdir(), `openclaw-api-outside-${Date.now()}`);
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const database = openDatabase(":memory:");
    migrate(database);
    const server = await buildServer({
      config: {
        ...config,
        workspace: {
          root: workspace
        }
      },
      database,
      llmProvider
    });

    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/memory/ingest",
        payload: {
          folder: outside
        }
      });

      expect(response.statusCode).toBe(403);
      expect(countRows(database, "documents")).toBe(0);
    } finally {
      await server.close();
      database.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("requires approval for file.write, invalidates changed input, and consumes the lease once", async () => {
    const workspace = join(tmpdir(), `openclaw-api-files-${Date.now()}`);
    const target = join(workspace, "notes", "approved.txt");
    mkdirSync(workspace, { recursive: true });
    const database = openDatabase(":memory:");
    migrate(database);
    const server = await buildServer({
      config: {
        ...config,
        workspace: {
          root: workspace
        }
      },
      database,
      llmProvider
    });

    try {
      const pendingResponse = await server.inject({
        method: "POST",
        url: "/api/files/write",
        payload: {
          path: "notes/approved.txt",
          content: "first"
        }
      });
      const pendingBody = pendingResponse.json() as {
        error: { name: string; approvalRequestId: string; payloadHash: string };
      };
      const approvalsResponse = await server.inject({
        method: "GET",
        url: "/api/approvals"
      });
      const approvalResponse = await server.inject({
        method: "POST",
        url: `/api/approvals/${pendingBody.error.approvalRequestId}/approve`
      });
      const approvalBody = approvalResponse.json() as {
        leaseToken: string;
        approval: { id: string; status: string; payloadHash: string };
      };
      const changedResponse = await server.inject({
        method: "POST",
        url: "/api/files/write",
        payload: {
          path: "notes/approved.txt",
          content: "changed",
          approvalRequestId: approvalBody.approval.id,
          approvalLease: approvalBody.leaseToken
        }
      });
      expect(changedResponse.statusCode).toBe(403);
      expect(existsSync(target)).toBe(false);

      const approvedResponse = await server.inject({
        method: "POST",
        url: "/api/files/write",
        payload: {
          path: "notes/approved.txt",
          content: "first",
          approvalRequestId: approvalBody.approval.id,
          approvalLease: approvalBody.leaseToken
        }
      });
      const reuseResponse = await server.inject({
        method: "POST",
        url: "/api/files/write",
        payload: {
          path: "notes/approved.txt",
          content: "first",
          approvalRequestId: approvalBody.approval.id,
          approvalLease: approvalBody.leaseToken
        }
      });
      const auditRows = database
        .prepare("SELECT action FROM audit_events ORDER BY created_at ASC")
        .all()
        .map((row) => String((row as { action: unknown }).action));

      expect(pendingResponse.statusCode).toBe(403);
      expect(pendingBody.error).toMatchObject({
        name: "CapabilityApprovalRequiredError"
      });
      expect(approvalsResponse.json().approvals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: pendingBody.error.approvalRequestId,
            capabilityId: "file.write",
            payloadHash: pendingBody.error.payloadHash,
            status: "pending"
          })
        ])
      );
      expect(approvalResponse.statusCode).toBe(200);
      expect(approvalBody.approval).toMatchObject({
        status: "approved",
        payloadHash: pendingBody.error.payloadHash
      });
      expect(approvedResponse.statusCode).toBe(200);
      expect(approvedResponse.json()).toEqual({
        path: "workspace/notes/approved.txt"
      });
      expect(readFileSync(target, "utf8")).toBe("first");
      expect(reuseResponse.statusCode).toBe(403);
      expect(auditRows).toEqual(
        expect.arrayContaining([
          "approval.request.approved",
          "approval.lease.consumed",
          "capability.call.completed",
          "capability.call.denied"
        ])
      );
    } finally {
      await server.close();
      database.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("writes audit events for chat, retrieval, approvals, and writes", async () => {
    const workspace = join(tmpdir(), `openclaw-api-audit-${Date.now()}`);
    mkdirSync(workspace, { recursive: true });
    const target = join(workspace, "notes", "audit.txt");
    const database = openDatabase(":memory:");
    migrate(database);
    const server = await buildServer({
      config: {
        ...config,
        workspace: {
          root: workspace
        }
      },
      database,
      llmProvider
    });

    try {
      const chatResponse = await server.inject({
        method: "POST",
        url: "/api/chat",
        payload: {
          message: "Write audit coverage"
        }
      });
      const pendingWriteResponse = await server.inject({
        method: "POST",
        url: "/api/files/write",
        payload: {
          path: "notes/audit.txt",
          content: "audited"
        }
      });
      const pendingWriteBody = pendingWriteResponse.json() as {
        error: { approvalRequestId: string };
      };
      const approvalResponse = await server.inject({
        method: "POST",
        url: `/api/approvals/${pendingWriteBody.error.approvalRequestId}/approve`
      });
      const approvalBody = approvalResponse.json() as {
        leaseToken: string;
      };
      const approvedWriteResponse = await server.inject({
        method: "POST",
        url: "/api/files/write",
        payload: {
          path: "notes/audit.txt",
          content: "audited",
          approvalRequestId: pendingWriteBody.error.approvalRequestId,
          approvalLease: approvalBody.leaseToken
        }
      });
      const auditRows = database
        .prepare("SELECT action, target_id FROM audit_events ORDER BY created_at ASC")
        .all()
        .map((row) => row as { action: string; target_id: string | null });

      expect(chatResponse.statusCode).toBe(200);
      expect(pendingWriteResponse.statusCode).toBe(403);
      expect(approvalResponse.statusCode).toBe(200);
      expect(approvedWriteResponse.statusCode).toBe(200);
      expect(readFileSync(target, "utf8")).toBe("audited");
      expect(auditRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: "chat.run.started" }),
          expect.objectContaining({ action: "chat.run.completed" }),
          expect.objectContaining({ action: "capability.call.completed", target_id: "memory.search" }),
          expect.objectContaining({ action: "capability.call.approval_required", target_id: "file.write" }),
          expect.objectContaining({ action: "approval.request.approved", target_id: "file.write" }),
          expect.objectContaining({ action: "approval.lease.consumed", target_id: "file.write" }),
          expect.objectContaining({ action: "capability.call.completed", target_id: "file.write" })
        ])
      );
    } finally {
      await server.close();
      database.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("bounds file reads and approved writes to the configured workspace", async () => {
    const workspace = join(tmpdir(), `openclaw-api-bounds-${Date.now()}`);
    const outside = join(tmpdir(), `openclaw-api-bounds-outside-${Date.now()}`);
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(workspace, "inside.txt"), "inside");
    const outsideTarget = join(outside, "outside.txt");
    writeFileSync(outsideTarget, "outside");
    const database = openDatabase(":memory:");
    migrate(database);
    const server = await buildServer({
      config: {
        ...config,
        workspace: {
          root: workspace
        }
      },
      database,
      llmProvider
    });

    try {
      const readInsideResponse = await server.inject({
        method: "POST",
        url: "/api/files/read",
        payload: {
          path: "inside.txt"
        }
      });
      const readOutsideResponse = await server.inject({
        method: "POST",
        url: "/api/files/read",
        payload: {
          path: outsideTarget
        }
      });
      const pendingWriteResponse = await server.inject({
        method: "POST",
        url: "/api/files/write",
        payload: {
          path: "../openclaw-api-bounds-outside-denied.txt",
          content: "nope"
        }
      });
      const pendingWriteBody = pendingWriteResponse.json() as {
        error: { approvalRequestId: string };
      };
      const approvalResponse = await server.inject({
        method: "POST",
        url: `/api/approvals/${pendingWriteBody.error.approvalRequestId}/approve`
      });
      const approvalBody = approvalResponse.json() as {
        leaseToken: string;
      };
      const writeOutsideResponse = await server.inject({
        method: "POST",
        url: "/api/files/write",
        payload: {
          path: "../openclaw-api-bounds-outside-denied.txt",
          content: "nope",
          approvalRequestId: pendingWriteBody.error.approvalRequestId,
          approvalLease: approvalBody.leaseToken
        }
      });
      const auditRows = database
        .prepare("SELECT action FROM audit_events WHERE target_id IN ('file.read', 'file.write')")
        .all()
        .map((row) => String((row as { action: unknown }).action));

      expect(readInsideResponse.statusCode).toBe(200);
      expect(readInsideResponse.json()).toEqual({
        path: "workspace/inside.txt",
        content: "inside"
      });
      expect(readOutsideResponse.statusCode).toBe(403);
      expect(writeOutsideResponse.statusCode).toBe(403);
      expect(existsSync(join(tmpdir(), "openclaw-api-bounds-outside-denied.txt"))).toBe(false);
      expect(auditRows).toEqual(
        expect.arrayContaining(["capability.call.completed", "capability.call.failed"])
      );
    } finally {
      await server.close();
      database.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      rmSync(join(tmpdir(), "openclaw-api-bounds-outside-denied.txt"), { force: true });
    }
  });

  it("serves admin settings, approvals, audit events, and capability grants", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;

    const database = openDatabase(":memory:");
    migrate(database);
    const settingsConfig: AppConfig = {
      ...config,
      server: {
        ...config.server,
        port: 3001
      }
    };
    const server = await buildServer({
      config: settingsConfig,
      database,
      llmProvider
    });

    try {
      const outboundFetch = (server as typeof server & { outboundFetch: typeof fetch }).outboundFetch;
      const settingsResponse = await server.inject({
        method: "GET",
        url: "/api/settings"
      });
      const capabilitiesResponse = await server.inject({
        method: "GET",
        url: "/api/capabilities"
      });

      expect(settingsResponse.statusCode).toBe(200);
      expect(settingsResponse.json()).toMatchObject({
        config: {
          llm: {
            chatModel: "test-chat"
          }
        },
        networkStatus: {
          llmBaseUrlAllowed: true
        }
      });
      expect(capabilitiesResponse.statusCode).toBe(200);
      expect(capabilitiesResponse.json().capabilities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "file.write", requiresApproval: true }),
          expect.objectContaining({ id: "settings.update", requiresApproval: true })
        ])
      );
      expect(capabilitiesResponse.json().grants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ capabilityId: "memory.search", agentId: "default" })
        ])
      );

      await expect(outboundFetch("http://192.168.1.15:11434/v1")).rejects.toThrow(
        /blocked by offline network policy/
      );

      const nextSettings = {
        llm: {
          ...settingsConfig.llm,
          baseUrl: "http://192.168.1.15:11434/v1",
          chatModel: "lan-chat",
          embeddingModel: "lan-embed"
        },
        network: {
          ...settingsConfig.network,
          allowedHosts: [...settingsConfig.network.allowedHosts, "192.168.1.15"]
        },
        workspace: {
          root: "."
        }
      };
      const pendingResponse = await server.inject({
        method: "PUT",
        url: "/api/settings",
        payload: nextSettings
      });
      const pendingBody = pendingResponse.json() as {
        error: { approvalRequestId: string };
      };
      const approvalResponse = await server.inject({
        method: "POST",
        url: `/api/approvals/${pendingBody.error.approvalRequestId}/approve`
      });
      const approvalBody = approvalResponse.json() as {
        leaseToken: string;
      };
      const updateResponse = await server.inject({
        method: "PUT",
        url: "/api/settings",
        payload: {
          ...nextSettings,
          approvalRequestId: pendingBody.error.approvalRequestId,
          approvalLease: approvalBody.leaseToken
        }
      });
      const updatedSettingsResponse = await server.inject({
        method: "GET",
        url: "/api/settings"
      });
      const allowedResponse = await outboundFetch("http://192.168.1.15:11434/v1");

      expect(pendingResponse.statusCode).toBe(403);
      expect(approvalResponse.statusCode).toBe(200);
      expect(updateResponse.statusCode).toBe(200);
      expect(updateResponse.json()).toMatchObject({
        config: {
          llm: {
            baseUrl: "http://192.168.1.15:11434/v1",
            chatModel: "lan-chat"
          }
        },
        networkStatus: {
          llmBaseUrlAllowed: true
        }
      });
      expect(updatedSettingsResponse.json().config.llm.chatModel).toBe("lan-chat");
      expect(allowedResponse.status).toBe(200);

      const disableGrantResponse = await server.inject({
        method: "POST",
        url: "/api/capabilities/memory.search/grants/default",
        payload: {
          granted: false
        }
      });
      const enableGrantResponse = await server.inject({
        method: "POST",
        url: "/api/capabilities/memory.search/grants/default",
        payload: {
          granted: true
        }
      });
      const auditResponse = await server.inject({
        method: "GET",
        url: "/api/audit"
      });
      const auditActions = (auditResponse.json() as { events: Array<{ action: string }> }).events.map(
        (event) => event.action
      );

      expect(disableGrantResponse.statusCode).toBe(200);
      expect(disableGrantResponse.json().grants).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ capabilityId: "memory.search", agentId: "default" })
        ])
      );
      expect(enableGrantResponse.statusCode).toBe(200);
      expect(enableGrantResponse.json().grants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ capabilityId: "memory.search", agentId: "default" })
        ])
      );
      expect(auditResponse.statusCode).toBe(200);
      expect(auditActions).toEqual(
        expect.arrayContaining([
          "settings.update.completed",
          "capability.grant.disabled",
          "capability.grant.enabled"
        ])
      );
    } finally {
      await server.close();
      database.close();
      globalThis.fetch = originalFetch;
    }
  });

  it("denies approval requests through the approvals API", async () => {
    const workspace = join(tmpdir(), `openclaw-api-files-${Date.now()}`);
    mkdirSync(workspace, { recursive: true });
    const database = openDatabase(":memory:");
    migrate(database);
    const server = await buildServer({
      config: {
        ...config,
        workspace: {
          root: workspace
        }
      },
      database,
      llmProvider
    });

    try {
      const pendingResponse = await server.inject({
        method: "POST",
        url: "/api/files/write",
        payload: {
          path: "notes/denied.txt",
          content: "nope"
        }
      });
      const pendingBody = pendingResponse.json() as {
        error: { approvalRequestId: string };
      };
      const denyResponse = await server.inject({
        method: "POST",
        url: `/api/approvals/${pendingBody.error.approvalRequestId}/deny`
      });
      const approveAfterDenyResponse = await server.inject({
        method: "POST",
        url: `/api/approvals/${pendingBody.error.approvalRequestId}/approve`
      });
      const auditRows = database
        .prepare("SELECT action FROM audit_events ORDER BY created_at ASC")
        .all()
        .map((row) => String((row as { action: unknown }).action));

      expect(denyResponse.statusCode).toBe(200);
      expect(denyResponse.json().approval).toMatchObject({
        id: pendingBody.error.approvalRequestId,
        status: "rejected"
      });
      expect(approveAfterDenyResponse.statusCode).toBe(409);
      expect(auditRows).toContain("approval.request.denied");
    } finally {
      await server.close();
      database.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

function parseSse(payload: string): Array<{ event: string; data: Record<string, unknown> }> {
  return payload
    .trim()
    .split(/\n\n/)
    .filter(Boolean)
    .map((block) => {
      const eventLine = block.split("\n").find((line) => line.startsWith("event: "));
      const dataLine = block.split("\n").find((line) => line.startsWith("data: "));

      return {
        event: eventLine?.slice("event: ".length) ?? "message",
        data: JSON.parse(dataLine?.slice("data: ".length) ?? "{}") as Record<string, unknown>
      };
    });
}

function countRows(database: ReturnType<typeof openDatabase>, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };

  return row.count;
}

async function ingestWithApproval(
  server: Awaited<ReturnType<typeof buildServer>>,
  folder: string
) {
  const pendingResponse = await server.inject({
    method: "POST",
    url: "/api/memory/ingest",
    payload: {
      folder
    }
  });
  const pendingBody = pendingResponse.json() as {
    error: { approvalRequestId: string };
  };

  expect(pendingResponse.statusCode).toBe(403);
  expect(pendingBody.error.approvalRequestId).toEqual(expect.any(String));

  const approvalResponse = await server.inject({
    method: "POST",
    url: `/api/approvals/${pendingBody.error.approvalRequestId}/approve`
  });
  const approvalBody = approvalResponse.json() as {
    leaseToken: string;
  };

  expect(approvalResponse.statusCode).toBe(200);

  return server.inject({
    method: "POST",
    url: "/api/memory/ingest",
    payload: {
      folder,
      approvalRequestId: pendingBody.error.approvalRequestId,
      approvalLease: approvalBody.leaseToken
    }
  });
}
