import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, RefObject } from "react";

import type { AppConfig, HealthResponse } from "@openclaw/shared";

type HealthState =
  | { status: "loading" }
  | { status: "online"; data: HealthResponse }
  | { status: "offline"; message: string };

type View = "chat" | "documents" | "approvals" | "settings" | "audit" | "capabilities";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type ThreadSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

type StreamEvent = {
  event: string;
  data: Record<string, unknown>;
};

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

type CapabilityInfo = {
  id: string;
  version: string;
  risk: "low" | "medium" | "high";
  effects: string[];
  requiresApproval: boolean;
};

type CapabilityGrant = {
  capabilityId: string;
  agentId: string | null;
  userId: string | null;
};

type DocumentSummary = {
  id: string;
  title: string;
  sourceUri: string | null;
  mimeType: string | null;
  updatedAt: string;
  chunkCount: number;
};

type SettingsState = {
  config: AppConfig;
  networkStatus: {
    mode: "offline";
    allowLoopback: boolean;
    allowedHosts: string[];
    llmBaseUrlAllowed: boolean;
  };
};

type ApiError = {
  name: string;
  message: string;
  approvalRequestId?: string;
  payloadHash?: string;
};

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

export function App() {
  const [view, setView] = useState<View>("chat");
  const [health, setHealth] = useState<HealthState>({ status: "loading" });
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<AppConfig | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [ingestFolderPath, setIngestFolderPath] = useState("docs");
  const [ingestStatus, setIngestStatus] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityInfo[]>([]);
  const [grants, setGrants] = useState<CapabilityGrant[]>([]);
  const [settingsStatus, setSettingsStatus] = useState<string | null>(null);
  const [approvalActionId, setApprovalActionId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const activeTitle = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId)?.title ?? "OpenClaw Console",
    [activeThreadId, threads]
  );
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending");

  async function refreshAll() {
    await Promise.all([
      refreshHealth(),
      refreshSettings(),
      refreshThreads(),
      refreshDocuments(),
      refreshApprovals(),
      refreshAudit(),
      refreshCapabilities()
    ]);
  }

  async function refreshHealth() {
    try {
      const data = await getJson<HealthResponse>("/health");
      setHealth({ status: "online", data });
    } catch (error) {
      setHealth({
        status: "offline",
        message: error instanceof Error ? error.message : "Unable to reach API"
      });
    }
  }

  async function refreshSettings() {
    try {
      const data = await getJson<SettingsState>("/api/settings");
      setSettings(data);
      setSettingsDraft(data.config);
    } catch {
      return;
    }
  }

  async function refreshThreads() {
    try {
      const body = await getJson<{ threads: ThreadSummary[] }>("/api/threads");
      setThreads(body.threads);
    } catch {
      setThreads([]);
    }
  }

  async function refreshDocuments() {
    try {
      const body = await getJson<{ documents: DocumentSummary[] }>("/api/documents");
      setDocuments(body.documents);
    } catch {
      setDocuments([]);
    }
  }

  async function refreshApprovals() {
    try {
      const body = await getJson<{ approvals: ApprovalRecord[] }>("/api/approvals");
      setApprovals(body.approvals);
    } catch {
      setApprovals([]);
    }
  }

  async function refreshAudit() {
    try {
      const body = await getJson<{ events: AuditEvent[] }>("/api/audit");
      setAuditEvents(body.events);
    } catch {
      setAuditEvents([]);
    }
  }

  async function refreshCapabilities() {
    try {
      const body = await getJson<{
        capabilities: CapabilityInfo[];
        grants: CapabilityGrant[];
      }>("/api/capabilities");
      setCapabilities(body.capabilities);
      setGrants(body.grants);
    } catch {
      setCapabilities([]);
      setGrants([]);
    }
  }

  async function loadThread(threadId: string) {
    try {
      const body = await getJson<{
        messages: Array<{ id: string; role: string; content: string }>;
      }>(`/api/threads/${threadId}/messages`);

      setActiveThreadId(threadId);
      setMessages(
        body.messages
          .filter((message) => message.role === "user" || message.role === "assistant")
          .map((message) => ({
            id: message.id,
            role: message.role as "user" | "assistant",
            content: message.content
          }))
      );
      setView("chat");
    } catch {
      return;
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmed = input.trim();

    if (trimmed === "" || isStreaming) {
      return;
    }

    const assistantId = crypto.randomUUID();
    setInput("");
    setIsStreaming(true);
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: "user", content: trimmed },
      { id: assistantId, role: "assistant", content: "" }
    ]);

    try {
      const response = await fetch(`${apiBaseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          threadId: activeThreadId ?? undefined,
          message: trimmed
        })
      });

      if (!response.ok || !response.body) {
        throw new Error(`Chat returned ${response.status}`);
      }

      await readSse(response.body, (streamEvent) => {
        if (streamEvent.event === "meta" && typeof streamEvent.data.threadId === "string") {
          setActiveThreadId(streamEvent.data.threadId);
        }

        if (streamEvent.event === "delta" && typeof streamEvent.data.content === "string") {
          appendAssistantContent(assistantId, streamEvent.data.content);
        }

        if (streamEvent.event === "error") {
          appendAssistantContent(assistantId, readErrorMessage(streamEvent.data));
        }
      });

      await Promise.all([refreshThreads(), refreshAudit()]);
    } catch (error) {
      appendAssistantContent(
        assistantId,
        error instanceof Error ? `Request failed: ${error.message}` : "Request failed."
      );
    } finally {
      setIsStreaming(false);
    }
  }

  async function ingestWorkspaceFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const folder = ingestFolderPath.trim();

    if (folder === "") {
      return;
    }

    setIngestStatus("Requesting");

    try {
      const response = await postJson("/api/memory/ingest", { folder });

      if (!response.ok) {
        const error = await readApiError(response);

        if (error.approvalRequestId) {
          setIngestStatus("Approval needed");
          await Promise.all([refreshApprovals(), refreshAudit()]);
          return;
        }

        throw new Error(error.message);
      }

      const body = (await response.json()) as {
        scanned: number;
        ingested: Array<{ status: string }>;
      };
      const changed = body.ingested.filter((item) => item.status !== "unchanged").length;

      setIngestStatus(`${changed}/${body.scanned} indexed`);
      await Promise.all([refreshDocuments(), refreshAudit()]);
    } catch (error) {
      setIngestStatus(error instanceof Error ? error.message : "Ingest failed");
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!settingsDraft) {
      return;
    }

    setSettingsStatus("Requesting");

    try {
      const response = await putJson("/api/settings", settingsPayload(settingsDraft));

      if (!response.ok) {
        const error = await readApiError(response);

        if (error.approvalRequestId) {
          setSettingsStatus("Approval needed");
          await Promise.all([refreshApprovals(), refreshAudit()]);
          return;
        }

        throw new Error(error.message);
      }

      const body = (await response.json()) as SettingsState;
      setSettings(body);
      setSettingsDraft(body.config);
      setSettingsStatus("Saved");
      await refreshAudit();
    } catch (error) {
      setSettingsStatus(error instanceof Error ? error.message : "Settings failed");
    }
  }

  async function approveAndRun(approval: ApprovalRecord) {
    setApprovalActionId(approval.id);

    try {
      const approvalResponse = await postJson(`/api/approvals/${approval.id}/approve`, {});

      if (!approvalResponse.ok) {
        throw new Error((await readApiError(approvalResponse)).message);
      }

      const decision = (await approvalResponse.json()) as {
        leaseToken: string;
        approval: ApprovalRecord;
      };

      await runApprovedCapability(approval, decision.leaseToken);
      await Promise.all([
        refreshApprovals(),
        refreshDocuments(),
        refreshSettings(),
        refreshAudit(),
        refreshThreads()
      ]);
    } catch {
      await Promise.all([refreshApprovals(), refreshAudit()]);
    } finally {
      setApprovalActionId(null);
    }
  }

  async function denyApproval(approval: ApprovalRecord) {
    setApprovalActionId(approval.id);

    try {
      await postJson(`/api/approvals/${approval.id}/deny`, {});
      await Promise.all([refreshApprovals(), refreshAudit()]);
    } finally {
      setApprovalActionId(null);
    }
  }

  async function runApprovedCapability(approval: ApprovalRecord, leaseToken: string) {
    const payload = parseCanonicalPayload(approval);
    const inputValue = payload.input as Record<string, unknown>;
    const lease = {
      approvalRequestId: approval.id,
      approvalLease: leaseToken
    };

    if (approval.capabilityId === "documents.ingest" && typeof inputValue.folder === "string") {
      const response = await postJson("/api/memory/ingest", {
        folder: inputValue.folder,
        ...lease
      });

      if (!response.ok) {
        throw new Error((await readApiError(response)).message);
      }
    }

    if (
      approval.capabilityId === "file.write" &&
      typeof inputValue.path === "string" &&
      typeof inputValue.content === "string"
    ) {
      const response = await postJson("/api/files/write", {
        path: inputValue.path,
        content: inputValue.content,
        ...lease
      });

      if (!response.ok) {
        throw new Error((await readApiError(response)).message);
      }
    }

    if (approval.capabilityId === "settings.update" && inputValue.value) {
      const response = await putJson("/api/settings", {
        ...settingsPayload(inputValue.value as AppConfig),
        ...lease
      });

      if (!response.ok) {
        throw new Error((await readApiError(response)).message);
      }
    }
  }

  async function setGrant(capabilityId: string, granted: boolean) {
    const response = await postJson(`/api/capabilities/${encodeURIComponent(capabilityId)}/grants/default`, {
      granted
    });

    if (response.ok) {
      const body = (await response.json()) as {
        capabilities: CapabilityInfo[];
        grants: CapabilityGrant[];
      };
      setCapabilities(body.capabilities);
      setGrants(body.grants);
      await refreshAudit();
    }
  }

  function appendAssistantContent(messageId: string, content: string) {
    setMessages((current) =>
      current.map((message) =>
        message.id === messageId
          ? {
              ...message,
              content: `${message.content}${content}`
            }
          : message
      )
    );
  }

  function updateDraft(next: Partial<AppConfig>) {
    setSettingsDraft((current) => (current ? { ...current, ...next } : current));
  }

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Navigation">
        <div className="brand">
          <span className="brand-mark">OC</span>
          <span>OpenClaw</span>
        </div>
        <StatusBadge health={health} allowed={settings?.networkStatus.llmBaseUrlAllowed ?? true} />
        <nav className="primary-nav">
          {viewItems.map((item) => (
            <button
              className={view === item.id ? "nav-item active" : "nav-item"}
              key={item.id}
              type="button"
              onClick={() => {
                setView(item.id);
              }}
            >
              <span>{item.label}</span>
              {item.id === "approvals" && pendingApprovals.length > 0 ? (
                <strong>{pendingApprovals.length}</strong>
              ) : null}
            </button>
          ))}
        </nav>
        <button
          className="new-chat"
          type="button"
          onClick={() => {
            setActiveThreadId(null);
            setMessages([]);
            setView("chat");
          }}
        >
          New chat
        </button>
        <div className="thread-stack">
          {threads.map((thread) => (
            <button
              className={thread.id === activeThreadId ? "thread active" : "thread"}
              key={thread.id}
              type="button"
              onClick={() => void loadThread(thread.id)}
            >
              {thread.title}
            </button>
          ))}
        </div>
      </aside>

      <section className="panel">
        {view === "chat" ? (
          <ChatView
            activeTitle={activeTitle}
            input={input}
            isStreaming={isStreaming}
            messages={messages}
            onInput={setInput}
            onSubmit={sendMessage}
            scrollRef={scrollRef}
          />
        ) : null}
        {view === "documents" ? (
          <DocumentsView
            documents={documents}
            folder={ingestFolderPath}
            status={ingestStatus}
            onFolder={setIngestFolderPath}
            onSubmit={ingestWorkspaceFolder}
          />
        ) : null}
        {view === "approvals" ? (
          <ApprovalsView
            actionId={approvalActionId}
            approvals={approvals}
            onApprove={(approval) => void approveAndRun(approval)}
            onDeny={(approval) => void denyApproval(approval)}
          />
        ) : null}
        {view === "settings" ? (
          <SettingsView
            draft={settingsDraft}
            settings={settings}
            status={settingsStatus}
            onDraft={updateDraft}
            onSubmit={saveSettings}
          />
        ) : null}
        {view === "audit" ? <AuditView events={auditEvents} /> : null}
        {view === "capabilities" ? (
          <CapabilitiesView
            capabilities={capabilities}
            grants={grants}
            onGrant={(id, granted) => void setGrant(id, granted)}
          />
        ) : null}
      </section>
    </main>
  );
}

const viewItems: Array<{ id: View; label: string }> = [
  { id: "chat", label: "Chat" },
  { id: "documents", label: "Documents" },
  { id: "approvals", label: "Approvals" },
  { id: "settings", label: "Settings" },
  { id: "audit", label: "Audit" },
  { id: "capabilities", label: "Capabilities" }
];

function ChatView({
  activeTitle,
  input,
  isStreaming,
  messages,
  onInput,
  onSubmit,
  scrollRef
}: {
  activeTitle: string;
  input: string;
  isStreaming: boolean;
  messages: ChatMessage[];
  onInput: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <>
      <PanelHeader eyebrow="Admin Chat" title={activeTitle} />
      <div className="chat-window" aria-label="Chat transcript">
        {messages.length === 0 ? (
          <article className="message assistant">
            <span>assistant</span>
            <p>Ready.</p>
          </article>
        ) : (
          messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <span>{message.role === "assistant" ? "assistant" : "operator"}</span>
              <p>{message.content || "..."}</p>
            </article>
          ))
        )}
        <div ref={scrollRef} />
      </div>
      <form className="composer" onSubmit={onSubmit}>
        <input
          aria-label="Message"
          disabled={isStreaming}
          onChange={(event) => {
            onInput(event.target.value);
          }}
          placeholder="Message OpenClaw..."
          value={input}
        />
        <button disabled={isStreaming} type="submit">
          Send
        </button>
      </form>
    </>
  );
}

function DocumentsView({
  documents,
  folder,
  status,
  onFolder,
  onSubmit
}: {
  documents: DocumentSummary[];
  folder: string;
  status: string | null;
  onFolder: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <>
      <PanelHeader eyebrow="Memory" title="Document Ingestion" />
      <div className="content-grid">
        <form className="tool-form" onSubmit={onSubmit}>
          <label>
            Folder
            <input
              aria-label="Folder"
              onChange={(event) => {
                onFolder(event.target.value);
              }}
              value={folder}
            />
          </label>
          <button type="submit">Ingest</button>
          {status ? <span className="form-status">{status}</span> : null}
        </form>
        <div className="item-list">
          {documents.map((document) => (
            <article className="list-item" key={document.id}>
              <div>
                <strong>{document.title}</strong>
                <span>{document.sourceUri ? formatSourceUri(document.sourceUri) : document.mimeType}</span>
              </div>
              <small>{document.chunkCount} chunks</small>
            </article>
          ))}
        </div>
      </div>
    </>
  );
}

function ApprovalsView({
  actionId,
  approvals,
  onApprove,
  onDeny
}: {
  actionId: string | null;
  approvals: ApprovalRecord[];
  onApprove: (approval: ApprovalRecord) => void;
  onDeny: (approval: ApprovalRecord) => void;
}) {
  return (
    <>
      <PanelHeader eyebrow="Control" title="Approval Inbox" />
      <div className="content-grid">
        {approvals.map((approval) => (
          <article className="approval-item" key={approval.id}>
            <div>
              <strong>{approval.capabilityId ?? "approval"}</strong>
              <span>{approval.reason ?? approval.payloadHash ?? approval.id}</span>
            </div>
            <small className={`badge ${approval.status}`}>{approval.status}</small>
            <pre>{formatApprovalInput(approval)}</pre>
            {approval.status === "pending" ? (
              <div className="row-actions">
                <button
                  disabled={actionId === approval.id}
                  type="button"
                  onClick={() => {
                    onApprove(approval);
                  }}
                >
                  Approve
                </button>
                <button
                  className="secondary"
                  disabled={actionId === approval.id}
                  type="button"
                  onClick={() => {
                    onDeny(approval);
                  }}
                >
                  Deny
                </button>
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </>
  );
}

function SettingsView({
  draft,
  settings,
  status,
  onDraft,
  onSubmit
}: {
  draft: AppConfig | null;
  settings: SettingsState | null;
  status: string | null;
  onDraft: (next: Partial<AppConfig>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  if (!draft) {
    return (
      <>
        <PanelHeader eyebrow="Admin" title="Settings" />
        <div className="empty-state">Unavailable</div>
      </>
    );
  }

  return (
    <>
      <PanelHeader eyebrow="Admin" title="Settings" />
      <form className="settings-grid" onSubmit={onSubmit}>
        <section className="settings-section">
          <h2>Model</h2>
          <label>
            Base URL
            <input
              value={draft.llm.baseUrl}
              onChange={(event) => {
                onDraft({ llm: { ...draft.llm, baseUrl: event.target.value } });
              }}
            />
          </label>
          <label>
            API key
            <input
              value={draft.llm.apiKey}
              onChange={(event) => {
                onDraft({ llm: { ...draft.llm, apiKey: event.target.value } });
              }}
            />
          </label>
          <label>
            Chat model
            <input
              value={draft.llm.chatModel}
              onChange={(event) => {
                onDraft({ llm: { ...draft.llm, chatModel: event.target.value } });
              }}
            />
          </label>
          <label>
            Embedding model
            <input
              value={draft.llm.embeddingModel ?? ""}
              onChange={(event) => {
                onDraft({
                  llm: {
                    ...draft.llm,
                    embeddingModel: event.target.value.trim() || undefined
                  }
                });
              }}
            />
          </label>
        </section>
        <section className="settings-section">
          <h2>Workspace</h2>
          <label>
            Root
            <input
              value={draft.workspace.root}
              onChange={(event) => {
                onDraft({ workspace: { root: event.target.value } });
              }}
            />
          </label>
          <label>
            Allowed hosts
            <input
              value={draft.network.allowedHosts.join(", ")}
              onChange={(event) => {
                onDraft({
                  network: {
                    ...draft.network,
                    allowedHosts: event.target.value
                      .split(",")
                      .map((item) => item.trim())
                      .filter(Boolean)
                  }
                });
              }}
            />
          </label>
          <label className="checkbox-row">
            <input
              checked={draft.network.allowLoopback}
              type="checkbox"
              onChange={(event) => {
                onDraft({
                  network: {
                    ...draft.network,
                    allowLoopback: event.target.checked
                  }
                });
              }}
            />
            Loopback
          </label>
          <div className="network-strip">
            <span className={settings?.networkStatus.llmBaseUrlAllowed ? "dot ok" : "dot bad"} />
            <strong>{settings?.networkStatus.mode ?? "offline"}</strong>
            <span>{settings?.networkStatus.llmBaseUrlAllowed ? "LLM allowed" : "LLM blocked"}</span>
          </div>
        </section>
        <div className="form-footer">
          <button type="submit">Save settings</button>
          {status ? <span className="form-status">{status}</span> : null}
        </div>
      </form>
    </>
  );
}

function AuditView({ events }: { events: AuditEvent[] }) {
  return (
    <>
      <PanelHeader eyebrow="System" title="Audit Timeline" />
      <div className="timeline">
        {events.map((event) => (
          <article className="timeline-item" key={event.id}>
            <div>
              <strong>{event.action}</strong>
              <span>{[event.targetType, event.targetId].filter(Boolean).join(" / ") || "system"}</span>
            </div>
            <time>{formatDate(event.createdAt)}</time>
          </article>
        ))}
      </div>
    </>
  );
}

function CapabilitiesView({
  capabilities,
  grants,
  onGrant
}: {
  capabilities: CapabilityInfo[];
  grants: CapabilityGrant[];
  onGrant: (id: string, granted: boolean) => void;
}) {
  return (
    <>
      <PanelHeader eyebrow="Security" title="Capability Grants" />
      <div className="capability-table">
        {capabilities.map((capability) => {
          const granted = grants.some(
            (grant) => grant.capabilityId === capability.id && grant.agentId === "default"
          );

          return (
            <article className="capability-row" key={capability.id}>
              <div>
                <strong>{capability.id}</strong>
                <span>{capability.effects.join("; ")}</span>
              </div>
              <small className={`risk ${capability.risk}`}>{capability.risk}</small>
              <label className="switch-row">
                <input
                  checked={granted}
                  type="checkbox"
                  onChange={(event) => {
                    onGrant(capability.id, event.target.checked);
                  }}
                />
                Grant
              </label>
            </article>
          );
        })}
      </div>
    </>
  );
}

function PanelHeader({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <header className="panel-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
      </div>
    </header>
  );
}

function StatusBadge({ health, allowed }: { health: HealthState; allowed: boolean }) {
  if (health.status === "online") {
    return (
      <div className={allowed ? "status online" : "status warn"}>
        <span />
        {allowed ? "API online" : "LLM blocked"}
      </div>
    );
  }

  if (health.status === "offline") {
    return (
      <div className="status offline" title={health.message}>
        <span />
        API offline
      </div>
    );
  }

  return (
    <div className="status">
      <span />
      Checking API
    </div>
  );
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`);

  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }

  return (await response.json()) as T;
}

function postJson(path: string, payload: unknown): Promise<Response> {
  return fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

function putJson(path: string, payload: unknown): Promise<Response> {
  return fetch(`${apiBaseUrl}${path}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

async function readApiError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as { error?: ApiError };

    return body.error ?? { name: "Error", message: `Request returned ${response.status}` };
  } catch {
    return { name: "Error", message: `Request returned ${response.status}` };
  }
}

async function readSse(stream: ReadableStream<Uint8Array>, onEvent: (event: StreamEvent) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    buffer = flushSseBuffer(buffer, onEvent);
  }

  buffer += decoder.decode();
  flushSseBuffer(`${buffer}\n\n`, onEvent);
}

function flushSseBuffer(buffer: string, onEvent: (event: StreamEvent) => void): string {
  const blocks = buffer.split(/\n\n/);
  const remainder = blocks.pop() ?? "";

  for (const block of blocks) {
    const parsed = parseSseBlock(block);

    if (parsed) {
      onEvent(parsed);
    }
  }

  return remainder;
}

function parseSseBlock(block: string): StreamEvent | null {
  const lines = block.split(/\n/);
  const event = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length) ?? "message";
  const data = lines
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .join("\n");

  if (data === "") {
    return null;
  }

  return {
    event,
    data: JSON.parse(data) as Record<string, unknown>
  };
}

function settingsPayload(config: AppConfig) {
  return {
    llm: config.llm,
    workspace: config.workspace,
    network: config.network
  };
}

function parseCanonicalPayload(approval: ApprovalRecord): { input: unknown } {
  if (!approval.canonicalPayloadJson) {
    return { input: {} };
  }

  try {
    return JSON.parse(approval.canonicalPayloadJson) as { input: unknown };
  } catch {
    return { input: {} };
  }
}

function formatApprovalInput(approval: ApprovalRecord): string {
  const payload = parseCanonicalPayload(approval);

  return JSON.stringify(payload.input, null, 2);
}

function readErrorMessage(data: Record<string, unknown>): string {
  return typeof data.message === "string" ? data.message : "The local model returned an error.";
}

function formatSourceUri(value: string): string {
  return value.startsWith("file://") ? decodeURIComponent(value.slice("file://".length)) : value;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}
