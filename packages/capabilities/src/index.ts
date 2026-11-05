import { createHash, randomBytes } from "node:crypto";

import {
  createApprovalRequestRepository,
  createAuditEventRepository,
  createCapabilityRepository,
  type ApprovalRequestRecord,
  type CapabilityRisk,
  type DatabaseConnection
} from "@openclaw/db";
import { redactSensitiveValue } from "@openclaw/shared";
import { z, type ZodSchema } from "zod";

export type CapabilityDescriptor = {
  id: string;
  version: string;
  inputSchema: ZodSchema;
  risk: CapabilityRisk;
  effects: string[];
  requiresApproval: boolean;
};

export type CapabilitySubject = {
  agentId?: string | null;
  userId?: string | null;
};

export type ApprovalLease = {
  requestId: string;
  leaseToken: string;
};

export type CapabilityCallOptions<TResult> = {
  capabilityId: string;
  input: unknown;
  subject: CapabilitySubject;
  executionId?: string | null;
  approval?: ApprovalLease | null;
  approvalReason?: string | null;
  metadata?: Record<string, unknown>;
  run: (input: unknown, context: CapabilityCallContext) => Promise<TResult> | TResult;
};

export type CapabilityCallContext = {
  capability: CapabilityDescriptor;
  subject: Required<CapabilitySubject>;
  executionId?: string | null;
  approvalRequestId?: string | null;
};

export type ApprovalDecision = {
  approval: ApprovalRequestRecord;
  leaseToken: string;
};

export const initialCapabilityDescriptors: CapabilityDescriptor[] = [
  {
    id: "documents.search",
    version: "0.1.0",
    inputSchema: z
      .object({
        query: z.string().min(1),
        limit: z.number().int().positive().max(50).optional()
      })
      .strict(),
    risk: "low",
    effects: ["reads indexed document metadata and chunks"],
    requiresApproval: false
  },
  {
    id: "documents.read",
    version: "0.1.0",
    inputSchema: z
      .object({
        documentId: z.string().min(1).optional(),
        path: z.string().min(1).optional()
      })
      .strict()
      .refine((input) => input.documentId !== undefined || input.path !== undefined, {
        message: "documentId or path is required"
      }),
    risk: "low",
    effects: ["reads local workspace document content"],
    requiresApproval: false
  },
  {
    id: "documents.ingest",
    version: "0.1.0",
    inputSchema: z
      .object({
        folder: z.string().min(1)
      })
      .strict(),
    risk: "medium",
    effects: ["reads local workspace files", "writes document chunks and embeddings"],
    requiresApproval: true
  },
  {
    id: "memory.search",
    version: "0.1.0",
    inputSchema: z
      .object({
        query: z.string().min(1),
        limit: z.number().int().positive().max(50).optional()
      })
      .strict(),
    risk: "low",
    effects: ["reads indexed memory chunks"],
    requiresApproval: false
  },
  {
    id: "file.read",
    version: "0.1.0",
    inputSchema: z
      .object({
        path: z.string().min(1)
      })
      .strict(),
    risk: "low",
    effects: ["reads a local workspace file"],
    requiresApproval: false
  },
  {
    id: "file.write",
    version: "0.1.0",
    inputSchema: z
      .object({
        path: z.string().min(1),
        content: z.string()
      })
      .strict(),
    risk: "high",
    effects: ["writes a local workspace file"],
    requiresApproval: true
  },
  {
    id: "settings.update",
    version: "0.1.0",
    inputSchema: z
      .object({
        key: z.string().min(1),
        value: z.unknown()
      })
      .strict(),
    risk: "high",
    effects: ["updates local application settings"],
    requiresApproval: true
  }
];

export class CapabilityDeniedError extends Error {
  constructor(message: string, readonly capabilityId: string) {
    super(message);
    this.name = "CapabilityDeniedError";
  }
}

export class CapabilityApprovalRequiredError extends Error {
  constructor(
    message: string,
    readonly capabilityId: string,
    readonly approvalRequestId: string,
    readonly payloadHash: string
  ) {
    super(message);
    this.name = "CapabilityApprovalRequiredError";
  }
}

export class CapabilityValidationError extends Error {
  constructor(message: string, readonly capabilityId: string) {
    super(message);
    this.name = "CapabilityValidationError";
  }
}

export class CapabilityNotFoundError extends Error {
  constructor(capabilityId: string) {
    super(`Unknown capability: ${capabilityId}`);
    this.name = "CapabilityNotFoundError";
  }
}

export class ApprovalRequestNotFoundError extends Error {
  constructor(id: string) {
    super(`Approval request not found: ${id}`);
    this.name = "ApprovalRequestNotFoundError";
  }
}

export class ApprovalRequestNotPendingError extends Error {
  constructor(id: string) {
    super(`Approval request is not pending: ${id}`);
    this.name = "ApprovalRequestNotPendingError";
  }
}

export class CapabilityHost {
  private readonly descriptors = new Map<string, CapabilityDescriptor>();
  private readonly capabilities;
  private readonly approvals;
  private readonly auditEvents;

  constructor(input: {
    database: DatabaseConnection;
    descriptors?: CapabilityDescriptor[];
  }) {
    const descriptors = input.descriptors ?? initialCapabilityDescriptors;
    this.capabilities = createCapabilityRepository(input.database);
    this.approvals = createApprovalRequestRepository(input.database);
    this.auditEvents = createAuditEventRepository(input.database);

    for (const descriptor of descriptors) {
      this.descriptors.set(descriptor.id, descriptor);
      this.capabilities.upsertDescriptor({
        id: descriptor.id,
        version: descriptor.version,
        risk: descriptor.risk,
        effectsJson: JSON.stringify(descriptor.effects),
        requiresApproval: descriptor.requiresApproval,
        description: descriptor.effects.join("; ")
      });
    }
  }

  listDescriptors(): CapabilityDescriptor[] {
    return Array.from(this.descriptors.values()).sort((left, right) => left.id.localeCompare(right.id));
  }

  listApprovalRequests(): ApprovalRequestRecord[] {
    return this.approvals.list();
  }

  approveRequest(id: string, input: { resolvedByUserId?: string | null } = {}): ApprovalDecision {
    const existing = this.approvals.getById(id);

    if (!existing) {
      throw new ApprovalRequestNotFoundError(id);
    }

    if (existing.status !== "pending") {
      throw new ApprovalRequestNotPendingError(id);
    }

    const leaseToken = randomBytes(32).toString("base64url");
    const approval = this.approvals.approve({
      id,
      resolvedByUserId: input.resolvedByUserId ?? null,
      leaseTokenHash: hashText(leaseToken)
    });

    if (!approval || approval.status !== "approved") {
      throw new ApprovalRequestNotPendingError(id);
    }

    this.recordAudit("approval.request.approved", approval.capabilityId ?? "approval", {
      approvalRequestId: approval.id,
      capabilityId: approval.capabilityId,
      payloadHash: approval.payloadHash,
      resolvedByUserId: input.resolvedByUserId ?? null
    });

    return {
      approval,
      leaseToken
    };
  }

  denyRequest(id: string, input: { resolvedByUserId?: string | null } = {}): ApprovalRequestRecord {
    const existing = this.approvals.getById(id);

    if (!existing) {
      throw new ApprovalRequestNotFoundError(id);
    }

    if (existing.status !== "pending") {
      throw new ApprovalRequestNotPendingError(id);
    }

    const approval = this.approvals.deny({
      id,
      resolvedByUserId: input.resolvedByUserId ?? null
    });

    if (!approval || approval.status !== "rejected") {
      throw new ApprovalRequestNotPendingError(id);
    }

    this.recordAudit("approval.request.denied", approval.capabilityId ?? "approval", {
      approvalRequestId: approval.id,
      capabilityId: approval.capabilityId,
      payloadHash: approval.payloadHash,
      resolvedByUserId: input.resolvedByUserId ?? null
    });

    return approval;
  }

  ensureDefaultGrants(subject: CapabilitySubject): void {
    const normalized = normalizeSubject(subject);

    for (const descriptor of this.descriptors.values()) {
      this.capabilities.ensureGrant({
        capabilityId: descriptor.id,
        agentId: normalized.agentId,
        userId: normalized.userId
      });
    }
  }

  async execute<TResult>(options: CapabilityCallOptions<TResult>): Promise<TResult> {
    const descriptor = this.descriptors.get(options.capabilityId);

    if (!descriptor) {
      throw new CapabilityNotFoundError(options.capabilityId);
    }

    const subject = normalizeSubject(options.subject);
    const parsed = descriptor.inputSchema.safeParse(options.input);
    const basePayload = {
      capabilityId: descriptor.id,
      version: descriptor.version,
      risk: descriptor.risk,
      effects: descriptor.effects,
      requiresApproval: descriptor.requiresApproval,
      subject,
      executionId: options.executionId ?? null,
      metadata: options.metadata ?? {}
    };

    this.recordAudit("capability.call.started", descriptor.id, basePayload);

    if (!parsed.success) {
      const error = new CapabilityValidationError("Capability input did not match its schema.", descriptor.id);

      this.recordAudit("capability.call.denied", descriptor.id, {
        ...basePayload,
        reason: "invalid_input"
      });
      throw error;
    }

    const canonicalPayloadJson = canonicalizeCapabilityPayload({
      capabilityId: descriptor.id,
      input: parsed.data,
      subject
    });
    const payloadHash = hashText(canonicalPayloadJson);
    const callPayload = {
      ...basePayload,
      payloadHash,
      canonicalPayloadJson
    };

    if (!this.capabilities.hasGrant({ capabilityId: descriptor.id, ...subject })) {
      const error = new CapabilityDeniedError(`Missing grant for capability: ${descriptor.id}`, descriptor.id);

      this.recordAudit("capability.call.denied", descriptor.id, {
        ...callPayload,
        reason: "missing_grant"
      });
      throw error;
    }

    const approvalRequestId = descriptor.requiresApproval
      ? this.resolveApproval({
          descriptor,
          subject,
          executionId: options.executionId ?? null,
          approval: options.approval ?? null,
          approvalReason: options.approvalReason ?? null,
          callPayload,
          payloadHash,
          canonicalPayloadJson
        })
      : null;

    try {
      const result = await options.run(parsed.data, {
        capability: descriptor,
        subject,
        executionId: options.executionId ?? null,
        approvalRequestId
      });

      this.recordAudit("capability.call.completed", descriptor.id, {
        ...callPayload,
        approvalRequestId
      });

      return result;
    } catch (error) {
      this.recordAudit("capability.call.failed", descriptor.id, {
        ...callPayload,
        approvalRequestId,
        error: serializeError(error)
      });
      throw error;
    }
  }

  private resolveApproval(input: {
    descriptor: CapabilityDescriptor;
    subject: Required<CapabilitySubject>;
    executionId: string | null;
    approval: ApprovalLease | null;
    approvalReason: string | null;
    callPayload: Record<string, unknown>;
    payloadHash: string;
    canonicalPayloadJson: string;
  }): string {
    if (!input.approval) {
      const approval = this.approvals.create({
        executionId: input.executionId,
        requestedByUserId: input.subject.userId,
        reason: input.approvalReason ?? `Capability requires approval: ${input.descriptor.id}`,
        payloadJson: JSON.stringify(input.callPayload),
        capabilityId: input.descriptor.id,
        subjectAgentId: input.subject.agentId,
        subjectUserId: input.subject.userId,
        payloadHash: input.payloadHash,
        canonicalPayloadJson: input.canonicalPayloadJson
      });

      this.recordAudit("capability.call.approval_required", input.descriptor.id, {
        ...input.callPayload,
        approvalRequestId: approval.id
      });
      throw new CapabilityApprovalRequiredError(
        `Approval required for capability: ${input.descriptor.id}`,
        input.descriptor.id,
        approval.id,
        input.payloadHash
      );
    }

    const consumed = this.approvals.consumeLease({
      id: input.approval.requestId,
      leaseTokenHash: hashText(input.approval.leaseToken),
      payloadHash: input.payloadHash
    });

    if (!consumed) {
      const error = new CapabilityDeniedError(
        `Approval lease does not match this exact payload: ${input.descriptor.id}`,
        input.descriptor.id
      );

      this.recordAudit("capability.call.denied", input.descriptor.id, {
        ...input.callPayload,
        approvalRequestId: input.approval.requestId,
        reason: "invalid_or_used_approval_lease"
      });
      throw error;
    }

    this.recordAudit("approval.lease.consumed", input.descriptor.id, {
      ...input.callPayload,
      approvalRequestId: consumed.id
    });

    return consumed.id;
  }

  private recordAudit(action: string, capabilityId: string, payload: Record<string, unknown>): void {
    this.auditEvents.record({
      action,
      targetType: "capability",
      targetId: capabilityId,
      payloadJson: JSON.stringify(redactSensitiveValue(payload))
    });
  }
}

export function createCapabilityHost(input: {
  database: DatabaseConnection;
  descriptors?: CapabilityDescriptor[];
}): CapabilityHost {
  return new CapabilityHost(input);
}

export function canonicalizeCapabilityPayload(input: {
  capabilityId: string;
  input: unknown;
  subject: Required<CapabilitySubject>;
}): string {
  return stableStringify(input);
}

function normalizeSubject(subject: CapabilitySubject): Required<CapabilitySubject> {
  const normalized = {
    agentId: subject.agentId ?? null,
    userId: subject.userId ?? null
  };

  if (normalized.agentId === null && normalized.userId === null) {
    throw new CapabilityDeniedError("Capability subject is required.", "unknown");
  }

  return normalized;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function serializeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
    };
  }

  return {
    name: "Error",
    message: "Unknown capability error."
  };
}
