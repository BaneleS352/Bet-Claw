import { expect, test, type Page, type Route } from "@playwright/test";

type ApprovalRecord = {
  id: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  reason: string | null;
  capabilityId: string | null;
  payloadHash: string | null;
  canonicalPayloadJson: string | null;
  createdAt: string;
  resolvedAt: string | null;
  leaseUsedAt: string | null;
};

type AuditEvent = {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  payloadJson: string;
  createdAt: string;
};

type CapabilityGrant = {
  capabilityId: string;
  agentId: string | null;
  userId: string | null;
};

type AppConfig = {
  server: { host: string; port: number };
  llm: {
    provider: "openai-compatible";
    baseUrl: string;
    apiKey: string;
    chatModel: string;
    embeddingModel?: string;
  };
  network: {
    mode: "offline";
    allowLoopback: boolean;
    allowedHosts: string[];
  };
  workspace: {
    root: string;
  };
};

const apiOrigin = "http://localhost:3001";

test("admin UI supports local config, chat citations, ingestion approvals, audit, and grants", async ({
  page
}) => {
  const state = createApiState();
  await mockApi(page, state);

  await page.goto("/");

  await expect(page.getByText("API online")).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Base URL")).toHaveValue("http://127.0.0.1:11434/v1");
  await page.getByLabel("Chat model").fill("local-ui-model");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Approval needed")).toBeVisible();

  await page.getByRole("button", { name: "Approvals" }).click();
  const settingsApproval = page.locator(".approval-item").filter({ hasText: "settings.update" });
  await expect(settingsApproval).toBeVisible();
  await settingsApproval.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Chat model")).toHaveValue("local-ui-model");

  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByLabel("Message").fill("What is the security policy?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Access requires local approval.")).toBeVisible();
  await expect(page.getByText("Sources:")).toBeVisible();
  await expect(page.getByText("- workspace/policies/security.md")).toBeVisible();

  await page.getByRole("button", { name: "Documents" }).click();
  await page.getByLabel("Folder").fill("docs");
  await page.getByRole("button", { name: "Ingest" }).click();
  await expect(page.getByText("Approval needed")).toBeVisible();

  await page.getByRole("button", { name: "Approvals" }).click();
  const ingestApproval = page.locator(".approval-item").filter({ hasText: "documents.ingest" });
  await expect(ingestApproval).toBeVisible();
  await ingestApproval.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("button", { name: "Documents" }).click();
  await expect(page.getByText("guide.txt", { exact: true })).toBeVisible();
  await expect(page.getByText("1 chunks")).toBeVisible();

  await page.getByRole("button", { name: "Capabilities" }).click();
  const memorySearchGrant = page.locator(".capability-row").filter({ hasText: "memory.search" });
  await expect(memorySearchGrant.getByLabel("Grant")).toBeChecked();
  await memorySearchGrant.getByLabel("Grant").click();
  await expect(memorySearchGrant.getByLabel("Grant")).not.toBeChecked();

  await page.getByRole("button", { name: "Audit" }).click();
  await expect(page.getByText("chat.run.completed")).toBeVisible();
  await expect(page.getByText("approval.request.approved").first()).toBeVisible();
  await expect(page.getByText("capability.grant.disabled")).toBeVisible();
});

test("approval inbox can deny write requests", async ({ page }) => {
  const state = createApiState();
  state.approvals.push(
    createApproval("file.write", {
      path: "notes/denied.txt",
      content: "nope"
    })
  );
  await mockApi(page, state);

  await page.goto("/");
  await page.getByRole("button", { name: "Approvals" }).click();

  const writeApproval = page.locator(".approval-item").filter({ hasText: "file.write" });
  await expect(writeApproval).toBeVisible();
  await writeApproval.getByRole("button", { name: "Deny" }).click();
  await expect(writeApproval.getByText("rejected")).toBeVisible();
});

function createApiState() {
  const config: AppConfig = {
    server: {
      host: "127.0.0.1",
      port: 3001
    },
    llm: {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "local-development-key",
      chatModel: "local-chat",
      embeddingModel: "local-embedding"
    },
    network: {
      mode: "offline",
      allowLoopback: true,
      allowedHosts: ["127.0.0.1", "localhost"]
    },
    workspace: {
      root: "."
    }
  };

  return {
    config,
    approvals: [] as ApprovalRecord[],
    auditEvents: [
      createAuditEvent("system.ready", "system", "openclaw")
    ] as AuditEvent[],
    documents: [] as Array<{
      id: string;
      title: string;
      sourceUri: string;
      mimeType: string;
      updatedAt: string;
      chunkCount: number;
    }>,
    grants: [
      { capabilityId: "documents.search", agentId: "default", userId: null },
      { capabilityId: "documents.read", agentId: "default", userId: null },
      { capabilityId: "documents.ingest", agentId: "default", userId: null },
      { capabilityId: "memory.search", agentId: "default", userId: null },
      { capabilityId: "file.read", agentId: "default", userId: null },
      { capabilityId: "file.write", agentId: "default", userId: null },
      { capabilityId: "settings.update", agentId: "default", userId: null }
    ] as CapabilityGrant[],
    threads: [] as Array<{ id: string; title: string; updatedAt: string }>
  };
}

async function mockApi(page: Page, state: ReturnType<typeof createApiState>) {
  await page.route(`${apiOrigin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (method === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: corsHeaders()
      });
      return;
    }

    if (method === "GET" && url.pathname === "/health") {
      await json(route, {
        ok: true,
        service: "openclaw-api",
        uptimeSeconds: 1,
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/settings") {
      await json(route, settingsBody(state.config));
      return;
    }

    if (method === "PUT" && url.pathname === "/api/settings") {
      const body = request.postDataJSON() as Partial<AppConfig> & {
        approvalRequestId?: string;
        approvalLease?: string;
      };
      const nextConfig = mergeConfig(state.config, body);

      if (!body.approvalRequestId || !body.approvalLease) {
        const approval = createApproval("settings.update", {
          key: "app.config",
          value: nextConfig
        });
        state.approvals.push(approval);
        state.auditEvents.unshift(createAuditEvent("capability.call.approval_required", "capability", "settings.update"));
        await json(route, approvalError(approval), 403);
        return;
      }

      state.config = nextConfig;
      markLeaseUsed(state.approvals, body.approvalRequestId);
      state.auditEvents.unshift(createAuditEvent("settings.update.completed", "settings", "app.config"));
      await json(route, settingsBody(state.config));
      return;
    }

    if (method === "GET" && url.pathname === "/api/threads") {
      await json(route, { threads: state.threads });
      return;
    }

    if (method === "GET" && /^\/api\/threads\/[^/]+\/messages$/.test(url.pathname)) {
      await json(route, { messages: [] });
      return;
    }

    if (method === "GET" && url.pathname === "/api/documents") {
      await json(route, { documents: state.documents });
      return;
    }

    if (method === "GET" && url.pathname === "/api/approvals") {
      await json(route, { approvals: state.approvals });
      return;
    }

    if (method === "POST" && /^\/api\/approvals\/[^/]+\/approve$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3] ?? "";
      const approval = state.approvals.find((item) => item.id === id);

      if (!approval) {
        await json(route, { error: { name: "NotFound", message: "Approval not found." } }, 404);
        return;
      }

      approval.status = "approved";
      approval.resolvedAt = new Date().toISOString();
      state.auditEvents.unshift(createAuditEvent("approval.request.approved", "capability", approval.capabilityId));
      await json(route, {
        approval,
        leaseToken: `lease-${id}`
      });
      return;
    }

    if (method === "POST" && /^\/api\/approvals\/[^/]+\/deny$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3] ?? "";
      const approval = state.approvals.find((item) => item.id === id);

      if (!approval) {
        await json(route, { error: { name: "NotFound", message: "Approval not found." } }, 404);
        return;
      }

      approval.status = "rejected";
      approval.resolvedAt = new Date().toISOString();
      state.auditEvents.unshift(createAuditEvent("approval.request.denied", "capability", approval.capabilityId));
      await json(route, { approval });
      return;
    }

    if (method === "GET" && url.pathname === "/api/audit") {
      await json(route, { events: state.auditEvents });
      return;
    }

    if (method === "GET" && url.pathname === "/api/capabilities") {
      await json(route, capabilitiesBody(state.grants));
      return;
    }

    if (method === "POST" && /^\/api\/capabilities\/[^/]+\/grants\/default$/.test(url.pathname)) {
      const capabilityId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      const body = request.postDataJSON() as { granted: boolean };

      if (body.granted) {
        if (!state.grants.some((grant) => grant.capabilityId === capabilityId && grant.agentId === "default")) {
          state.grants.push({ capabilityId, agentId: "default", userId: null });
        }
      } else {
        state.grants = state.grants.filter(
          (grant) => !(grant.capabilityId === capabilityId && grant.agentId === "default")
        );
      }

      state.auditEvents.unshift(
        createAuditEvent(body.granted ? "capability.grant.enabled" : "capability.grant.disabled", "capability", capabilityId)
      );
      await json(route, capabilitiesBody(state.grants));
      return;
    }

    if (method === "POST" && url.pathname === "/api/memory/ingest") {
      const body = request.postDataJSON() as {
        folder: string;
        approvalRequestId?: string;
        approvalLease?: string;
      };

      if (!body.approvalRequestId || !body.approvalLease) {
        const approval = createApproval("documents.ingest", {
          folder: body.folder
        });
        state.approvals.push(approval);
        state.auditEvents.unshift(createAuditEvent("capability.call.approval_required", "capability", "documents.ingest"));
        await json(route, approvalError(approval), 403);
        return;
      }

      markLeaseUsed(state.approvals, body.approvalRequestId);
      state.documents = [
        {
          id: "doc-guide",
          title: "guide.txt",
          sourceUri: "file:///workspace/docs/guide.txt",
          mimeType: "text/plain",
          updatedAt: new Date().toISOString(),
          chunkCount: 1
        }
      ];
      state.auditEvents.unshift(createAuditEvent("memory.ingest.completed", "folder", body.folder));
      await json(route, {
        workspaceRoot: ".",
        folder: body.folder,
        scanned: 1,
        ingested: [{ path: "docs/guide.txt", documentId: "doc-guide", status: "created", chunks: 1 }],
        rejected: []
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/chat") {
      state.threads = [{ id: "thread-1", title: "What is the security policy?", updatedAt: new Date().toISOString() }];
      state.auditEvents.unshift(createAuditEvent("capability.call.completed", "capability", "memory.search"));
      state.auditEvents.unshift(createAuditEvent("chat.run.completed", "execution", "exec-1"));
      await sse(route, [
        ["meta", { threadId: "thread-1", executionId: "exec-1", userMessageId: "msg-user", agentId: "default" }],
        ["delta", { content: "Access requires local approval." }],
        ["delta", { content: "\n\nSources:\n- workspace/policies/security.md" }],
        [
          "done",
          {
            threadId: "thread-1",
            executionId: "exec-1",
            assistantMessageId: "msg-assistant",
            citations: ["workspace/policies/security.md"],
            retrievedChunkIds: ["chunk-1"]
          }
        ]
      ]);
      return;
    }

    await json(route, { error: { name: "UnhandledMockRoute", message: `${method} ${url.pathname}` } }, 500);
  });
}

function settingsBody(config: AppConfig) {
  return {
    config,
    networkStatus: {
      mode: "offline",
      allowLoopback: config.network.allowLoopback,
      allowedHosts: config.network.allowedHosts,
      llmBaseUrlAllowed: true
    }
  };
}

function capabilitiesBody(grants: CapabilityGrant[]) {
  return {
    capabilities: [
      descriptor("documents.search", "low", false),
      descriptor("documents.read", "low", false),
      descriptor("documents.ingest", "medium", true),
      descriptor("memory.search", "low", false),
      descriptor("file.read", "low", false),
      descriptor("file.write", "high", true),
      descriptor("settings.update", "high", true)
    ],
    grants
  };
}

function descriptor(id: string, risk: "low" | "medium" | "high", requiresApproval: boolean) {
  return {
    id,
    version: "0.1.0",
    risk,
    effects: [`${id} effect`],
    requiresApproval
  };
}

function mergeConfig(current: AppConfig, input: Partial<AppConfig>): AppConfig {
  return {
    server: current.server,
    llm: {
      ...current.llm,
      ...input.llm
    },
    network: {
      ...current.network,
      ...input.network
    },
    workspace: {
      ...current.workspace,
      ...input.workspace
    }
  };
}

function createApproval(capabilityId: string, input: unknown): ApprovalRecord {
  const id = `approval-${Math.random().toString(16).slice(2)}`;

  return {
    id,
    status: "pending",
    reason: `Approval required for ${capabilityId}`,
    capabilityId,
    payloadHash: `hash-${id}`,
    canonicalPayloadJson: JSON.stringify({ input }),
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    leaseUsedAt: null
  };
}

function approvalError(approval: ApprovalRecord) {
  return {
    error: {
      name: "CapabilityApprovalRequiredError",
      message: "Approval required.",
      approvalRequestId: approval.id,
      payloadHash: approval.payloadHash
    }
  };
}

function markLeaseUsed(approvals: ApprovalRecord[], id: string | undefined) {
  const approval = approvals.find((item) => item.id === id);

  if (approval) {
    approval.leaseUsedAt = new Date().toISOString();
  }
}

function createAuditEvent(action: string, targetType: string | null, targetId: string | null): AuditEvent {
  return {
    id: `audit-${Math.random().toString(16).slice(2)}`,
    action,
    targetType,
    targetId,
    payloadJson: "{}",
    createdAt: new Date().toISOString()
  };
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    headers: {
      ...corsHeaders(),
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

async function sse(route: Route, events: Array<[string, Record<string, unknown>]>) {
  await route.fulfill({
    status: 200,
    headers: {
      ...corsHeaders(),
      "cache-control": "no-cache",
      "content-type": "text/event-stream; charset=utf-8"
    },
    body: events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("")
  });
}

function corsHeaders() {
  return {
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-allow-origin": "*"
  };
}
