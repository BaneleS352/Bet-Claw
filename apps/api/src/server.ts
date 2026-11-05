import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { Readable } from "node:stream";

import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";

import {
  createAgentOS,
  registerExampleRoutines,
  registerExampleSkills,
  type AgentOS,
  type RoutineDefinition,
  type ScheduleDefinition
} from "@openclaw/agent-os";
import {
  CapabilityApprovalRequiredError,
  CapabilityDeniedError,
  CapabilityValidationError,
  ApprovalRequestNotFoundError,
  ApprovalRequestNotPendingError,
  createCapabilityHost,
  type ApprovalLease
} from "@openclaw/capabilities";
import { assertUrlAllowed, createPolicyFetch, isUrlAllowed, loadConfig } from "@openclaw/config";
import {
  createAgentRepository,
  createAuditEventRepository,
  createCapabilityRepository,
  createSettingsRepository,
  type ApprovalRequestRecord,
  type DatabaseConnection
} from "@openclaw/db";
import {
  chatRequestSchema,
  createLlmProvider,
  embeddingRequestSchema,
  redactError,
  serializeSafeError,
  type LlmProvider,
  type SafeErrorPayload
} from "@openclaw/llm";
import {
  assertInsideWorkspace,
  ingestFolder,
  resolveWorkspacePath,
  resolveWorkspaceRoot,
  WorkspacePathError
} from "@openclaw/memory";
import { appConfigSchema, healthResponseSchema, type AppConfig } from "@openclaw/shared";

import { createChatRuntime, type ChatRunInput, type ChatRuntime } from "./chat-runtime.js";

export type BuildServerOptions = {
  config?: AppConfig;
  database?: DatabaseConnection;
  llmProvider?: LlmProvider;
  agentOS?: AgentOS;
};

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const server = Fastify({
    logger: true
  });
  const llmProvider = options.llmProvider ?? createLlmProvider(config);
  const auditEvents = options.database ? createAuditEventRepository(options.database) : null;
  const capabilityRepository = options.database ? createCapabilityRepository(options.database) : null;
  const settingsRepository = options.database ? createSettingsRepository(options.database) : null;
  const agentOS =
    options.agentOS ??
    (options.database
      ? createAgentOS({
          database: options.database,
          heartbeatIntervalMs: config.agentOs.heartbeatIntervalMs,
          jobsPerHeartbeat: config.agentOs.jobsPerHeartbeat,
          jobRetryDelayMs: config.agentOs.jobRetryDelayMs
        })
      : null);
  const defaultAgent = options.database
    ? createAgentRepository(options.database).ensureDefault({ model: config.llm.chatModel })
    : null;
  const capabilityHost = options.database ? createCapabilityHost({ database: options.database }) : null;

  if (capabilityHost && defaultAgent) {
    capabilityHost.ensureDefaultGrants({ agentId: defaultAgent.id });
  }

  if (agentOS) {
    registerExampleSkills(agentOS.skills);
    registerExampleRoutines(agentOS);

    if (config.agentOs.enabled) {
      agentOS.start();
    }
  }

  const chatRuntime = options.database
    ? createChatRuntime({
        config,
        database: options.database,
        llmProvider,
        capabilityHost: capabilityHost ?? undefined
      })
    : null;

  await server.register(cors, {
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"]
  });

  const originalFetch = globalThis.fetch;
  const outboundFetch = createPolicyFetch(config.network, originalFetch);
  globalThis.fetch = outboundFetch;
  server.decorate("outboundFetch", outboundFetch);
  server.addHook("onClose", () => {
    globalThis.fetch = originalFetch;
  });
  server.addHook("onClose", async () => {
    await agentOS?.stop();
  });

  server.get("/health", async () =>
    healthResponseSchema.parse({
      ok: true,
      service: "openclaw-api",
      uptimeSeconds: process.uptime(),
      timestamp: new Date().toISOString()
    })
  );

  server.post("/chat/stream", async (request, reply) => {
    const parsed = chatRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          name: "ValidationError",
          message: "Invalid chat request."
        } satisfies SafeErrorPayload
      });
    }

    return reply
      .header("content-type", "text/event-stream; charset=utf-8")
      .header("cache-control", "no-cache")
      .header("connection", "keep-alive")
      .send(
        Readable.from(
          streamChatAsSse(llmProvider, parsed.data, (error) => {
            recordLlmError(error, "llm.chat.error");
          })
        )
      );
  });

  server.post("/embeddings", async (request, reply) => {
    const parsed = embeddingRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          name: "ValidationError",
          message: "Invalid embeddings request."
        } satisfies SafeErrorPayload
      });
    }

    try {
      return {
        embeddings: await llmProvider.embed(parsed.data.input)
      };
    } catch (error) {
      recordLlmError(error, "llm.embeddings.error");

      return reply.code(502).send({
        error: redactError(error)
      });
    }
  });

  server.post("/api/chat", async (request, reply) => {
    if (!chatRuntime) {
      return reply.code(503).send({
        error: {
          name: "DatabaseUnavailable",
          message: "Chat runtime requires a database connection."
        } satisfies SafeErrorPayload
      });
    }

    const parsed = parseChatRunInput(request.body);

    if (!parsed.ok) {
      return reply.code(400).send({
        error: {
          name: "ValidationError",
          message: parsed.message
        } satisfies SafeErrorPayload
      });
    }

    return reply
      .header("content-type", "text/event-stream; charset=utf-8")
      .header("cache-control", "no-cache")
      .header("connection", "keep-alive")
      .send(Readable.from(streamRuntimeEventsAsSse(chatRuntime, parsed.input)));
  });

  server.get("/api/threads", async (_request, reply) => {
    if (!chatRuntime) {
      return reply.code(503).send({
        error: {
          name: "DatabaseUnavailable",
          message: "Thread listing requires a database connection."
        } satisfies SafeErrorPayload
      });
    }

    return {
      threads: chatRuntime.listThreads()
    };
  });

  server.get("/api/threads/:id/messages", async (request, reply) => {
    if (!chatRuntime) {
      return reply.code(503).send({
        error: {
          name: "DatabaseUnavailable",
          message: "Message listing requires a database connection."
        } satisfies SafeErrorPayload
      });
    }

    return {
      messages: chatRuntime.listThreadMessages(readRouteId(request.params))
    };
  });

  server.get("/api/executions/:id/events", async (request, reply) => {
    if (!chatRuntime) {
      return reply.code(503).send({
        error: {
          name: "DatabaseUnavailable",
          message: "Execution event listing requires a database connection."
        } satisfies SafeErrorPayload
      });
    }

    return {
      events: chatRuntime.listExecutionEvents(readRouteId(request.params))
    };
  });

  server.get("/api/settings", async (_request, reply) => {
    if (!options.database) {
      return reply.code(503).send({
        error: {
          name: "DatabaseUnavailable",
          message: "Settings require a database connection."
        } satisfies SafeErrorPayload
      });
    }

    return {
      config,
      networkStatus: createNetworkStatus(config)
    };
  });

  server.put("/api/settings", async (request, reply) => {
    if (!capabilityHost || !defaultAgent || !settingsRepository) {
      return reply.code(503).send({
        error: {
          name: "CapabilityHostUnavailable",
          message: "Settings updates require the capability host."
        } satisfies SafeErrorPayload
      });
    }

    const parsed = parseSettingsInput(request.body, config);

    if (!parsed.ok) {
      return reply.code(400).send({
        error: {
          name: "ValidationError",
          message: parsed.message
        } satisfies SafeErrorPayload
      });
    }

    try {
      const nextConfig = await capabilityHost.execute({
        capabilityId: "settings.update",
        input: {
          key: "app.config",
          value: parsed.config
        },
        subject: {
          agentId: defaultAgent.id
        },
        approval: parsed.approval,
        approvalReason: "Operator requested local model or workspace settings update.",
        metadata: {
          route: "/api/settings"
        },
        run() {
          applyRuntimeConfig(config, parsed.config);
          settingsRepository.set("app.config", JSON.stringify(parsed.config));
          auditEvents?.record({
            action: "settings.update.completed",
            targetType: "settings",
            targetId: "app.config",
            payloadJson: JSON.stringify({
              llmBaseUrl: parsed.config.llm.baseUrl,
              chatModel: parsed.config.llm.chatModel,
              embeddingModel: parsed.config.llm.embeddingModel ?? null,
              workspaceRoot: parsed.config.workspace.root,
              network: parsed.config.network
            })
          });

          return parsed.config;
        }
      });

      return {
        config: nextConfig,
        networkStatus: createNetworkStatus(nextConfig)
      };
    } catch (error) {
      return reply.code(errorToStatusCode(error)).send({
        error: toErrorPayload(error)
      });
    }
  });

  server.get("/api/audit", async (_request, reply) => {
    if (!auditEvents) {
      return reply.code(503).send({
        error: {
          name: "DatabaseUnavailable",
          message: "Audit timeline requires a database connection."
        } satisfies SafeErrorPayload
      });
    }

    return {
      events: auditEvents.list(200)
    };
  });

  server.get("/api/capabilities", async (_request, reply) => {
    if (!capabilityHost || !capabilityRepository) {
      return reply.code(503).send({
        error: {
          name: "CapabilityHostUnavailable",
          message: "Capability listing requires the capability host."
        } satisfies SafeErrorPayload
      });
    }

    return {
      capabilities: capabilityHost.listDescriptors().map((descriptor) => ({
        id: descriptor.id,
        version: descriptor.version,
        risk: descriptor.risk,
        effects: descriptor.effects,
        requiresApproval: descriptor.requiresApproval
      })),
      grants: capabilityRepository.listGrants()
    };
  });

  server.post("/api/capabilities/:id/grants/default", async (request, reply) => {
    if (!capabilityRepository || !defaultAgent || !auditEvents) {
      return reply.code(503).send({
        error: {
          name: "CapabilityHostUnavailable",
          message: "Capability grants require the capability host."
        } satisfies SafeErrorPayload
      });
    }

    const parsed = parseGrantInput(request.body);
    const capabilityId = readRouteId(request.params);

    if (!parsed.ok) {
      return reply.code(400).send({
        error: {
          name: "ValidationError",
          message: parsed.message
        } satisfies SafeErrorPayload
      });
    }

    if (parsed.granted) {
      capabilityRepository.ensureGrant({
        capabilityId,
        agentId: defaultAgent.id
      });
    } else {
      capabilityRepository.revokeGrant({
        capabilityId,
        agentId: defaultAgent.id
      });
    }

    auditEvents.record({
      action: parsed.granted ? "capability.grant.enabled" : "capability.grant.disabled",
      targetType: "capability",
      targetId: capabilityId,
      payloadJson: JSON.stringify({
        agentId: defaultAgent.id
      })
    });

    return {
      capabilities: capabilityHost?.listDescriptors().map((descriptor) => ({
        id: descriptor.id,
        version: descriptor.version,
        risk: descriptor.risk,
        effects: descriptor.effects,
        requiresApproval: descriptor.requiresApproval
      })) ?? [],
      grants: capabilityRepository.listGrants()
    };
  });

  server.get("/api/agent-os/status", async (_request, reply) => {
    if (!agentOS) {
      return reply.code(503).send({
        error: {
          name: "AgentOSUnavailable",
          message: "Agent OS requires a database connection."
        } satisfies SafeErrorPayload
      });
    }

    return agentOS.status();
  });

  server.post("/api/heartbeat/pulse", async (_request, reply) => {
    if (!agentOS) {
      return reply.code(503).send({
        error: {
          name: "AgentOSUnavailable",
          message: "Heartbeat requires the Agent OS runtime."
        } satisfies SafeErrorPayload
      });
    }

    return {
      heartbeat: await agentOS.heartbeat.pulse()
    };
  });

  server.get("/api/skills", async (_request, reply) => {
    if (!agentOS) {
      return reply.code(503).send({
        error: {
          name: "AgentOSUnavailable",
          message: "Skill listing requires the Agent OS runtime."
        } satisfies SafeErrorPayload
      });
    }

    return {
      skills: agentOS.skills.list()
    };
  });

  server.post("/api/skills/:id/jobs", async (request, reply) => {
    if (!agentOS) {
      return reply.code(503).send({
        error: {
          name: "AgentOSUnavailable",
          message: "Skill jobs require the Agent OS runtime."
        } satisfies SafeErrorPayload
      });
    }

    const parsed = parseJobRunInput(request.body);

    if (!parsed.ok) {
      return reply.code(400).send({
        error: {
          name: "ValidationError",
          message: parsed.message
        } satisfies SafeErrorPayload
      });
    }

    return {
      job: agentOS.jobs.enqueueSkill({
        skillId: readRouteId(request.params),
        payload: parsed.input,
        maxAttempts: parsed.maxAttempts
      })
    };
  });

  server.get("/api/routines", async (_request, reply) => {
    if (!agentOS) {
      return reply.code(503).send({
        error: {
          name: "AgentOSUnavailable",
          message: "Routine listing requires the Agent OS runtime."
        } satisfies SafeErrorPayload
      });
    }

    return {
      routines: agentOS.routines.list()
    };
  });

  server.post("/api/routines", async (request, reply) => {
    if (!agentOS) {
      return reply.code(503).send({
        error: {
          name: "AgentOSUnavailable",
          message: "Routine registration requires the Agent OS runtime."
        } satisfies SafeErrorPayload
      });
    }

    const parsed = parseRoutineDefinition(request.body);

    if (!parsed.ok) {
      return reply.code(400).send({
        error: {
          name: "ValidationError",
          message: parsed.message
        } satisfies SafeErrorPayload
      });
    }

    try {
      return {
        routine: agentOS.registerRoutine(parsed.routine)
      };
    } catch (error) {
      return reply.code(400).send({
        error: toErrorPayload(error)
      });
    }
  });

  server.post("/api/routines/:id/run", async (request, reply) => {
    if (!agentOS) {
      return reply.code(503).send({
        error: {
          name: "AgentOSUnavailable",
          message: "Routine jobs require the Agent OS runtime."
        } satisfies SafeErrorPayload
      });
    }

    const parsed = parseJobRunInput(request.body);

    if (!parsed.ok) {
      return reply.code(400).send({
        error: {
          name: "ValidationError",
          message: parsed.message
        } satisfies SafeErrorPayload
      });
    }

    return {
      job: agentOS.jobs.enqueueRoutine({
        routineId: readRouteId(request.params),
        payload: parsed.input,
        maxAttempts: parsed.maxAttempts
      })
    };
  });

  server.post("/api/routines/:id/schedules", async (request, reply) => {
    if (!agentOS) {
      return reply.code(503).send({
        error: {
          name: "AgentOSUnavailable",
          message: "Routine schedules require the Agent OS runtime."
        } satisfies SafeErrorPayload
      });
    }

    const parsed = parseScheduleInput(request.body);

    if (!parsed.ok) {
      return reply.code(400).send({
        error: {
          name: "ValidationError",
          message: parsed.message
        } satisfies SafeErrorPayload
      });
    }

    try {
      return {
        schedule: agentOS.scheduler.scheduleRoutine({
          routineId: readRouteId(request.params),
          name: parsed.name,
          schedule: parsed.schedule,
          payload: parsed.input
        })
      };
    } catch (error) {
      return reply.code(400).send({
        error: toErrorPayload(error)
      });
    }
  });

  server.get("/api/schedules", async (_request, reply) => {
    if (!agentOS) {
      return reply.code(503).send({
        error: {
          name: "AgentOSUnavailable",
          message: "Schedule listing requires the Agent OS runtime."
        } satisfies SafeErrorPayload
      });
    }

    return {
      schedules: agentOS.scheduler.list()
    };
  });

  server.post("/api/schedules/:id/cancel", async (request, reply) => {
    if (!agentOS) {
      return reply.code(503).send({
        error: {
          name: "AgentOSUnavailable",
          message: "Schedule cancellation requires the Agent OS runtime."
        } satisfies SafeErrorPayload
      });
    }

    return {
      schedule: agentOS.scheduler.cancel(readRouteId(request.params))
    };
  });

  server.get("/api/jobs", async (request, reply) => {
    if (!agentOS) {
      return reply.code(503).send({
        error: {
          name: "AgentOSUnavailable",
          message: "Job listing requires the Agent OS runtime."
        } satisfies SafeErrorPayload
      });
    }

    const query = parseJobListQuery(request.query);

    return {
      jobs: agentOS.jobs.list(query),
      stats: agentOS.jobs.stats()
    };
  });

  server.get("/api/jobs/:id/logs", async (request, reply) => {
    if (!agentOS) {
      return reply.code(503).send({
        error: {
          name: "AgentOSUnavailable",
          message: "Job logs require the Agent OS runtime."
        } satisfies SafeErrorPayload
      });
    }

    return {
      logs: agentOS.jobs.logs(readRouteId(request.params))
    };
  });

  server.post("/api/jobs/:id/cancel", async (request, reply) => {
    if (!agentOS) {
      return reply.code(503).send({
        error: {
          name: "AgentOSUnavailable",
          message: "Job cancellation requires the Agent OS runtime."
        } satisfies SafeErrorPayload
      });
    }

    return {
      job: agentOS.jobs.cancel(readRouteId(request.params))
    };
  });

  server.post("/api/jobs/process", async (request, reply) => {
    if (!agentOS) {
      return reply.code(503).send({
        error: {
          name: "AgentOSUnavailable",
          message: "Job processing requires the Agent OS runtime."
        } satisfies SafeErrorPayload
      });
    }

    const parsed = parseProcessJobsInput(request.body);

    if (!parsed.ok) {
      return reply.code(400).send({
        error: {
          name: "ValidationError",
          message: parsed.message
        } satisfies SafeErrorPayload
      });
    }

    return {
      processed: await agentOS.jobs.processAvailable({
        limit: parsed.limit
      }),
      stats: agentOS.jobs.stats()
    };
  });

  server.get("/api/documents", async (_request, reply) => {
    if (!options.database) {
      return reply.code(503).send({
        error: {
          name: "DatabaseUnavailable",
          message: "Document listing requires a database connection."
        } satisfies SafeErrorPayload
      });
    }

    return {
      documents: listDocuments(options.database)
    };
  });

  server.get("/api/approvals", async (_request, reply) => {
    if (!capabilityHost) {
      return reply.code(503).send({
        error: {
          name: "CapabilityHostUnavailable",
          message: "Approval listing requires the capability host."
        } satisfies SafeErrorPayload
      });
    }

    return {
      approvals: capabilityHost.listApprovalRequests().map(toApprovalResponse)
    };
  });

  server.post("/api/approvals/:id/approve", async (request, reply) => {
    if (!capabilityHost) {
      return reply.code(503).send({
        error: {
          name: "CapabilityHostUnavailable",
          message: "Approval decisions require the capability host."
        } satisfies SafeErrorPayload
      });
    }

    try {
      const decision = capabilityHost.approveRequest(readRouteId(request.params));

      return {
        approval: toApprovalResponse(decision.approval),
        leaseToken: decision.leaseToken
      };
    } catch (error) {
      return reply.code(errorToStatusCode(error)).send({
        error: toErrorPayload(error)
      });
    }
  });

  server.post("/api/approvals/:id/deny", async (request, reply) => {
    if (!capabilityHost) {
      return reply.code(503).send({
        error: {
          name: "CapabilityHostUnavailable",
          message: "Approval decisions require the capability host."
        } satisfies SafeErrorPayload
      });
    }

    try {
      return {
        approval: toApprovalResponse(capabilityHost.denyRequest(readRouteId(request.params)))
      };
    } catch (error) {
      return reply.code(errorToStatusCode(error)).send({
        error: toErrorPayload(error)
      });
    }
  });

  server.post("/api/files/read", async (request, reply) => {
    if (!capabilityHost || !defaultAgent) {
      return reply.code(503).send({
        error: {
          name: "CapabilityHostUnavailable",
          message: "File reads require the capability host."
        } satisfies SafeErrorPayload
      });
    }

    const parsed = parseFileReadInput(request.body);

    if (!parsed.ok) {
      return reply.code(400).send({
        error: {
          name: "ValidationError",
          message: parsed.message
        } satisfies SafeErrorPayload
      });
    }

    try {
      return await capabilityHost.execute({
        capabilityId: "file.read",
        input: {
          path: parsed.path
        },
        subject: {
          agentId: defaultAgent.id
        },
        metadata: {
          route: "/api/files/read"
        },
        run(capabilityInput) {
          const fileInput = capabilityInput as { path: string };
          const workspaceRoot = resolveWorkspaceRoot(config.workspace.root);
          const targetPath = resolveWorkspacePath(workspaceRoot, fileInput.path);

          return {
            path: toWorkspacePath(workspaceRoot, targetPath),
            content: readFileSync(targetPath, "utf8")
          };
        }
      });
    } catch (error) {
      return reply.code(errorToStatusCode(error)).send({
        error: toErrorPayload(error)
      });
    }
  });

  server.post("/api/files/write", async (request, reply) => {
    if (!capabilityHost || !defaultAgent) {
      return reply.code(503).send({
        error: {
          name: "CapabilityHostUnavailable",
          message: "File writes require the capability host."
        } satisfies SafeErrorPayload
      });
    }

    const parsed = parseFileWriteInput(request.body);

    if (!parsed.ok) {
      return reply.code(400).send({
        error: {
          name: "ValidationError",
          message: parsed.message
        } satisfies SafeErrorPayload
      });
    }

    try {
      return await capabilityHost.execute({
        capabilityId: "file.write",
        input: {
          path: parsed.input.path,
          content: parsed.input.content
        },
        subject: {
          agentId: defaultAgent.id
        },
        approval: parsed.input.approval,
        approvalReason: "Operator requested a local file write through the API.",
        metadata: {
          route: "/api/files/write"
        },
        run(capabilityInput) {
          const fileInput = capabilityInput as { path: string; content: string };
          const workspaceRoot = resolveWorkspaceRoot(config.workspace.root);
          const targetPath = resolveWorkspacePath(workspaceRoot, fileInput.path);

          mkdirSync(dirname(targetPath), { recursive: true });
          assertInsideWorkspace(dirname(targetPath), workspaceRoot);
          writeFileSync(targetPath, fileInput.content, "utf8");

          return {
            path: toWorkspacePath(workspaceRoot, targetPath)
          };
        }
      });
    } catch (error) {
      return reply.code(errorToStatusCode(error)).send({
        error: toErrorPayload(error)
      });
    }
  });

  server.post("/api/memory/ingest", async (request, reply) => {
    if (!options.database) {
      return reply.code(503).send({
        error: {
          name: "DatabaseUnavailable",
          message: "Memory ingestion requires a database connection."
        } satisfies SafeErrorPayload
      });
    }

    const database = options.database;
    const parsed = parseIngestInput(request.body);

    if (!parsed.ok) {
      return reply.code(400).send({
        error: {
          name: "ValidationError",
          message: parsed.message
        } satisfies SafeErrorPayload
      });
    }

    try {
      if (!capabilityHost || !defaultAgent) {
        return reply.code(503).send({
          error: {
            name: "CapabilityHostUnavailable",
            message: "Memory ingestion requires the capability host."
          } satisfies SafeErrorPayload
        });
      }

      const result = await capabilityHost.execute({
        capabilityId: "documents.ingest",
        input: {
          folder: parsed.folder
        },
        subject: {
          agentId: defaultAgent.id
        },
        approval: parsed.approval,
        approvalReason: "Operator requested document ingestion through the local API.",
        metadata: {
          route: "/api/memory/ingest"
        },
        run(capabilityInput) {
          const ingestInput = capabilityInput as { folder: string };

          return ingestFolder({
            folder: ingestInput.folder,
            config,
            database,
            embeddingProvider: llmProvider
          });
        }
      });

      auditEvents?.record({
        action: "memory.ingest.completed",
        targetType: "folder",
        targetId: result.folder,
        payloadJson: JSON.stringify({
          scanned: result.scanned,
          ingested: result.ingested.length
        })
      });

      return result;
    } catch (error) {
      const safeError = toErrorPayload(error);

      auditEvents?.record({
        action: "memory.ingest.failed",
        targetType: "folder",
        targetId: parsed.folder,
        payloadJson: JSON.stringify(safeError)
      });

      return reply.code(errorToStatusCode(error)).send({
        error: safeError
      });
    }
  });

  return server;

  function recordLlmError(error: unknown, action: string): void {
    if (!auditEvents) {
      return;
    }

    try {
      auditEvents.record({
        action,
        targetType: "llm",
        payloadJson: serializeSafeError(error)
      });
    } catch (auditError) {
      server.log.warn({ error: redactError(auditError) }, "failed to store redacted LLM error");
    }
  }
}

function errorToStatusCode(error: unknown): number {
  if (error instanceof CapabilityValidationError) {
    return 400;
  }

  if (error instanceof ApprovalRequestNotFoundError) {
    return 404;
  }

  if (error instanceof ApprovalRequestNotPendingError) {
    return 409;
  }

  if (
    error instanceof WorkspacePathError ||
    error instanceof CapabilityDeniedError ||
    error instanceof CapabilityApprovalRequiredError
  ) {
    return 403;
  }

  return 500;
}

function toErrorPayload(error: unknown): SafeErrorPayload & {
  approvalRequestId?: string;
  payloadHash?: string;
} {
  const safeError = redactError(error);

  if (error instanceof CapabilityApprovalRequiredError) {
    return {
      ...safeError,
      approvalRequestId: error.approvalRequestId,
      payloadHash: error.payloadHash
    };
  }

  return safeError;
}

function toApprovalResponse(approval: ApprovalRequestRecord) {
  return {
    id: approval.id,
    executionId: approval.executionId,
    status: approval.status,
    reason: approval.reason,
    payloadJson: approval.payloadJson,
    resolvedByUserId: approval.resolvedByUserId,
    createdAt: approval.createdAt,
    resolvedAt: approval.resolvedAt,
    capabilityId: approval.capabilityId,
    subjectAgentId: approval.subjectAgentId,
    subjectUserId: approval.subjectUserId,
    payloadHash: approval.payloadHash,
    canonicalPayloadJson: approval.canonicalPayloadJson,
    leaseIssuedAt: approval.leaseIssuedAt,
    leaseUsedAt: approval.leaseUsedAt
  };
}

function toWorkspacePath(workspaceRoot: string, targetPath: string): string {
  return `workspace/${relative(workspaceRoot, targetPath).split(/[\\/]/).join("/")}`;
}

function createNetworkStatus(config: AppConfig) {
  return {
    mode: config.network.mode,
    allowLoopback: config.network.allowLoopback,
    allowedHosts: config.network.allowedHosts,
    llmBaseUrlAllowed: isUrlAllowed(config.llm.baseUrl, config.network)
  };
}

function applyRuntimeConfig(target: AppConfig, next: AppConfig): void {
  target.server.host = next.server.host;
  target.server.port = next.server.port;
  target.llm.provider = next.llm.provider;
  target.llm.baseUrl = next.llm.baseUrl;
  target.llm.apiKey = next.llm.apiKey;
  target.llm.chatModel = next.llm.chatModel;
  target.llm.embeddingModel = next.llm.embeddingModel;
  target.network.mode = next.network.mode;
  target.network.allowLoopback = next.network.allowLoopback;
  target.network.allowedHosts = [...next.network.allowedHosts];
  target.workspace.root = next.workspace.root;
  target.agentOs.enabled = next.agentOs.enabled;
  target.agentOs.heartbeatIntervalMs = next.agentOs.heartbeatIntervalMs;
  target.agentOs.jobsPerHeartbeat = next.agentOs.jobsPerHeartbeat;
  target.agentOs.jobRetryDelayMs = next.agentOs.jobRetryDelayMs;
}

function listDocuments(database: DatabaseConnection) {
  return database
    .prepare(
      `
      SELECT
        d.id,
        d.title,
        d.source_uri,
        d.mime_type,
        d.content_hash,
        d.created_at,
        d.updated_at,
        COUNT(c.id) AS chunk_count
      FROM documents d
      LEFT JOIN document_chunks c ON c.document_id = d.id
      GROUP BY d.id
      ORDER BY d.updated_at DESC, d.title ASC
    `
    )
    .all()
    .map((row) => {
      const document = row as {
        id: string;
        title: string;
        source_uri: string | null;
        mime_type: string | null;
        content_hash: string | null;
        created_at: string;
        updated_at: string;
        chunk_count: number;
      };

      return {
        id: document.id,
        title: document.title,
        sourceUri: document.source_uri,
        mimeType: document.mime_type,
        contentHash: document.content_hash,
        createdAt: document.created_at,
        updatedAt: document.updated_at,
        chunkCount: document.chunk_count
      };
    });
}

async function* streamChatAsSse(
  llmProvider: LlmProvider,
  request: Parameters<LlmProvider["streamChat"]>[0],
  onError: (error: unknown) => void
): AsyncIterable<string> {
  try {
    for await (const delta of llmProvider.streamChat(request)) {
      yield `data: ${JSON.stringify(delta)}\n\n`;
    }
  } catch (error) {
    onError(error);
    yield `event: error\ndata: ${JSON.stringify(redactError(error))}\n\n`;
  }
}

async function* streamRuntimeEventsAsSse(
  chatRuntime: ChatRuntime,
  request: ChatRunInput
): AsyncIterable<string> {
  for await (const event of chatRuntime.run(request)) {
    yield `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
  }
}

function parseChatRunInput(body: unknown):
  | { ok: true; input: ChatRunInput }
  | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "Request body must be an object." };
  }

  const input = body as Record<string, unknown>;

  if (typeof input.message !== "string" || input.message.trim() === "") {
    return { ok: false, message: "Message is required." };
  }

  if (input.threadId !== undefined && typeof input.threadId !== "string") {
    return { ok: false, message: "threadId must be a string when provided." };
  }

  if (input.agentId !== undefined && typeof input.agentId !== "string") {
    return { ok: false, message: "agentId must be a string when provided." };
  }

  return {
    ok: true,
    input: {
      message: input.message,
      threadId: input.threadId,
      agentId: input.agentId
    }
  };
}

function parseSettingsInput(body: unknown, current: AppConfig):
  | { ok: true; config: AppConfig; approval: ApprovalLease | null }
  | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "Request body must be an object." };
  }

  const input = body as Record<string, unknown>;
  const approval = parseApprovalLease(input);

  if (!approval.ok) {
    return {
      ok: false,
      message: approval.message
    };
  }

  const candidate = appConfigSchema.safeParse({
    server: current.server,
    llm: input.llm ?? current.llm,
    network: input.network ?? current.network,
    workspace: input.workspace ?? current.workspace,
    agentOs: input.agentOs ?? current.agentOs
  });

  if (!candidate.success) {
    return {
      ok: false,
      message: "Settings did not match the app config schema."
    };
  }

  try {
    assertUrlAllowed(candidate.data.llm.baseUrl, candidate.data.network);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "LLM base URL is blocked."
    };
  }

  return {
    ok: true,
    config: candidate.data,
    approval: approval.approval
  };
}

function parseGrantInput(body: unknown): { ok: true; granted: boolean } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "Request body must be an object." };
  }

  const input = body as Record<string, unknown>;

  if (typeof input.granted !== "boolean") {
    return { ok: false, message: "granted must be a boolean." };
  }

  return {
    ok: true,
    granted: input.granted
  };
}

function parseRoutineDefinition(body: unknown):
  | { ok: true; routine: RoutineDefinition }
  | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "Request body must be an object." };
  }

  const input = body as Record<string, unknown>;

  if (typeof input.id !== "string" || input.id.trim() === "") {
    return { ok: false, message: "routine id is required." };
  }

  if (typeof input.name !== "string" || input.name.trim() === "") {
    return { ok: false, message: "routine name is required." };
  }

  if (!Array.isArray(input.steps)) {
    return { ok: false, message: "routine steps must be an array." };
  }

  const steps: RoutineDefinition["steps"] = [];

  for (const step of input.steps) {
    if (typeof step !== "object" || step === null) {
      return { ok: false, message: "routine step must be an object." };
    }

    const candidate = step as Record<string, unknown>;

    if (candidate.type === "skill" && typeof candidate.skillId === "string") {
      steps.push({
        id: typeof candidate.id === "string" ? candidate.id : undefined,
        type: "skill",
        skillId: candidate.skillId,
        input: candidate.input,
        description: typeof candidate.description === "string" ? candidate.description : undefined
      });
      continue;
    }

    if (candidate.type === "routine" && typeof candidate.routineId === "string") {
      steps.push({
        id: typeof candidate.id === "string" ? candidate.id : undefined,
        type: "routine",
        routineId: candidate.routineId,
        input: candidate.input,
        description: typeof candidate.description === "string" ? candidate.description : undefined
      });
      continue;
    }

    return { ok: false, message: "routine steps must reference a skillId or routineId." };
  }

  const schedule = input.schedule === undefined || input.schedule === null ? null : parseSchedule(input.schedule);

  if (schedule === "invalid") {
    return { ok: false, message: "routine schedule is invalid." };
  }

  return {
    ok: true,
    routine: {
      id: input.id,
      name: input.name,
      description: typeof input.description === "string" ? input.description : null,
      steps,
      schedule,
      enabled: typeof input.enabled === "boolean" ? input.enabled : true
    }
  };
}

function parseScheduleInput(body: unknown):
  | { ok: true; name?: string; schedule: ScheduleDefinition; input?: unknown }
  | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "Request body must be an object." };
  }

  const input = body as Record<string, unknown>;
  const schedule = parseSchedule(input.schedule);

  if (schedule === "invalid") {
    return { ok: false, message: "schedule is required and must be valid." };
  }

  return {
    ok: true,
    name: typeof input.name === "string" ? input.name : undefined,
    schedule,
    input: input.input
  };
}

function parseSchedule(value: unknown): ScheduleDefinition | "invalid" {
  if (typeof value !== "object" || value === null) {
    return "invalid";
  }

  const schedule = value as Record<string, unknown>;

  if (schedule.type === "once" && typeof schedule.runAt === "string") {
    return {
      type: "once",
      runAt: schedule.runAt
    };
  }

  if (schedule.type === "interval" && typeof schedule.everySeconds === "number") {
    return {
      type: "interval",
      everySeconds: schedule.everySeconds,
      startAt: typeof schedule.startAt === "string" ? schedule.startAt : undefined
    };
  }

  if (schedule.type === "cron" && typeof schedule.expression === "string") {
    return {
      type: "cron",
      expression: schedule.expression,
      startAt: typeof schedule.startAt === "string" ? schedule.startAt : undefined
    };
  }

  return "invalid";
}

function parseJobRunInput(body: unknown):
  | { ok: true; input?: unknown; maxAttempts?: number }
  | { ok: false; message: string } {
  if (body === undefined || body === null) {
    return {
      ok: true
    };
  }

  if (typeof body !== "object") {
    return { ok: false, message: "Request body must be an object." };
  }

  const input = body as Record<string, unknown>;

  if (
    input.maxAttempts !== undefined &&
    (!Number.isInteger(input.maxAttempts) || Number(input.maxAttempts) < 1)
  ) {
    return { ok: false, message: "maxAttempts must be a positive integer when provided." };
  }

  return {
    ok: true,
    input: input.input,
    maxAttempts: typeof input.maxAttempts === "number" ? input.maxAttempts : undefined
  };
}

function parseProcessJobsInput(body: unknown):
  | { ok: true; limit: number }
  | { ok: false; message: string } {
  if (body === undefined || body === null) {
    return {
      ok: true,
      limit: 1
    };
  }

  if (typeof body !== "object") {
    return { ok: false, message: "Request body must be an object." };
  }

  const input = body as Record<string, unknown>;

  if (input.limit !== undefined && (!Number.isInteger(input.limit) || Number(input.limit) < 1)) {
    return { ok: false, message: "limit must be a positive integer when provided." };
  }

  return {
    ok: true,
    limit: typeof input.limit === "number" ? input.limit : 1
  };
}

function parseJobListQuery(query: unknown): {
  status?: "pending" | "running" | "completed" | "failed" | "cancelled";
  limit?: number;
} {
  if (typeof query !== "object" || query === null) {
    return {};
  }

  const input = query as Record<string, unknown>;
  const status =
    input.status === "pending" ||
    input.status === "running" ||
    input.status === "completed" ||
    input.status === "failed" ||
    input.status === "cancelled"
      ? input.status
      : undefined;
  const limitValue = typeof input.limit === "string" ? Number.parseInt(input.limit, 10) : input.limit;
  const limit = typeof limitValue === "number" && Number.isInteger(limitValue) && limitValue > 0 ? limitValue : undefined;

  return {
    status,
    limit
  };
}

function readRouteId(params: unknown): string {
  if (typeof params === "object" && params !== null && "id" in params) {
    const id = (params as { id: unknown }).id;

    if (typeof id === "string") {
      return id;
    }
  }

  return "";
}

function parseIngestInput(body: unknown):
  | { ok: true; folder: string; approval: ApprovalLease | null }
  | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "Request body must be an object." };
  }

  const input = body as Record<string, unknown>;

  if (typeof input.folder !== "string" || input.folder.trim() === "") {
    return { ok: false, message: "folder is required." };
  }

  const approval = parseApprovalLease(input);

  if (!approval.ok) {
    return {
      ok: false,
      message: approval.message
    };
  }

  return {
    ok: true,
    folder: input.folder,
    approval: approval.approval
  };
}

function parseFileWriteInput(body: unknown):
  | {
      ok: true;
      input: {
        path: string;
        content: string;
        approval: ApprovalLease | null;
      };
    }
  | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "Request body must be an object." };
  }

  const input = body as Record<string, unknown>;

  if (typeof input.path !== "string" || input.path.trim() === "") {
    return { ok: false, message: "path is required." };
  }

  if (typeof input.content !== "string") {
    return { ok: false, message: "content must be a string." };
  }

  const approval = parseApprovalLease(input);

  if (!approval.ok) {
    return {
      ok: false,
      message: approval.message
    };
  }

  return {
    ok: true,
    input: {
      path: input.path,
      content: input.content,
      approval: approval.approval
    }
  };
}

function parseFileReadInput(body: unknown): { ok: true; path: string } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "Request body must be an object." };
  }

  const input = body as Record<string, unknown>;

  if (typeof input.path !== "string" || input.path.trim() === "") {
    return { ok: false, message: "path is required." };
  }

  return {
    ok: true,
    path: input.path
  };
}

function parseApprovalLease(input: Record<string, unknown>):
  | { ok: true; approval: ApprovalLease | null }
  | { ok: false; message: string } {
  const requestId = input.approvalRequestId;
  const leaseToken = input.approvalLease ?? input.leaseToken;

  if (requestId === undefined && leaseToken === undefined) {
    return {
      ok: true,
      approval: null
    };
  }

  if (typeof requestId !== "string" || requestId.trim() === "") {
    return { ok: false, message: "approvalRequestId must be a string when provided." };
  }

  if (typeof leaseToken !== "string" || leaseToken.trim() === "") {
    return { ok: false, message: "approvalLease must be a string when provided." };
  }

  return {
    ok: true,
    approval: {
      requestId,
      leaseToken
    }
  };
}
