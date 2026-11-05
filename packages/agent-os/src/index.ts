import { randomUUID } from "node:crypto";

import {
  createAgentStateRepository,
  createHeartbeatRepository,
  createJobLogRepository,
  createJobRepository,
  createRoutineRepository,
  createScheduledTaskRepository,
  createSkillRepository,
  type AgentStateRecord,
  type DatabaseConnection,
  type HeartbeatEventRecord,
  type JobLogLevel,
  type JobLogRecord,
  type JobRecord,
  type JobStatus,
  type RoutineRecord,
  type ScheduledTaskRecord,
  type SkillRecord
} from "@openclaw/db";
import { redactSensitiveValue } from "@openclaw/shared";

export type JsonObject = Record<string, unknown>;

export type ScheduleDefinition =
  | {
      type: "once";
      runAt: string;
    }
  | {
      type: "interval";
      everySeconds: number;
      startAt?: string;
    }
  | {
      type: "cron";
      expression: string;
      startAt?: string;
    };

export type RoutineStep =
  | {
      id?: string;
      type: "skill";
      skillId: string;
      input?: unknown;
      description?: string;
    }
  | {
      id?: string;
      type: "routine";
      routineId: string;
      input?: unknown;
      description?: string;
    };

export type RoutineDefinition = {
  id: string;
  name: string;
  description?: string | null;
  steps: RoutineStep[];
  schedule?: ScheduleDefinition | null;
  enabled?: boolean;
};

export type RoutineRunOutput = {
  routineId: string;
  outputs: Array<{
    stepId: string;
    type: RoutineStep["type"];
    result: unknown;
  }>;
};

export type SkillPermission = {
  resource: string;
  access: "read" | "write" | "execute";
  scope?: string;
};

export type SkillContext = {
  skill: SkillRecord;
  jobId?: string | null;
  routineId?: string | null;
  stepId?: string | null;
  metadata?: JsonObject;
  log(level: JobLogLevel, message: string, metadata?: JsonObject): void;
  state: {
    get(key: string): AgentStateRecord | null;
    set(key: string, value: unknown): AgentStateRecord;
  };
};

export type SkillDefinition<TInput = unknown, TResult = unknown> = {
  id: string;
  name: string;
  description?: string | null;
  version: string;
  permissions?: SkillPermission[];
  config?: JsonObject;
  enabled?: boolean;
  handler(input: TInput, context: SkillContext): Promise<TResult> | TResult;
};

export type AgentOSOptions = {
  database: DatabaseConnection;
  heartbeatIntervalMs?: number;
  jobsPerHeartbeat?: number;
  jobRetryDelayMs?: number;
};

export type ProcessedJobResult = {
  job: JobRecord;
  result?: unknown;
};

export class RoutineNotFoundError extends Error {
  constructor(id: string) {
    super(`Routine not found: ${id}`);
    this.name = "RoutineNotFoundError";
  }
}

export class RoutineDisabledError extends Error {
  constructor(id: string) {
    super(`Routine is disabled: ${id}`);
    this.name = "RoutineDisabledError";
  }
}

export class SkillNotFoundError extends Error {
  constructor(id: string) {
    super(`Skill not registered: ${id}`);
    this.name = "SkillNotFoundError";
  }
}

export class SkillDisabledError extends Error {
  constructor(id: string) {
    super(`Skill is disabled: ${id}`);
    this.name = "SkillDisabledError";
  }
}

export class ScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleValidationError";
  }
}

export class RoutineCycleError extends Error {
  constructor(id: string) {
    super(`Routine cycle detected at: ${id}`);
    this.name = "RoutineCycleError";
  }
}

export class SkillRegistry {
  private readonly definitions = new Map<string, SkillDefinition>();
  private readonly skills;
  private readonly state;

  constructor(input: {
    database: DatabaseConnection;
  }) {
    this.skills = createSkillRepository(input.database);
    this.state = createAgentStateRepository(input.database);
  }

  register<TInput, TResult>(definition: SkillDefinition<TInput, TResult>): SkillRecord {
    assertNonEmpty(definition.id, "Skill id is required.");
    assertNonEmpty(definition.name, "Skill name is required.");
    assertNonEmpty(definition.version, "Skill version is required.");

    this.definitions.set(definition.id, definition as SkillDefinition);

    return this.skills.upsert({
      id: definition.id,
      name: definition.name,
      description: definition.description ?? null,
      version: definition.version,
      permissionsJson: JSON.stringify(definition.permissions ?? []),
      configJson: JSON.stringify(definition.config ?? {}),
      enabled: definition.enabled !== false
    });
  }

  list(): SkillRecord[] {
    return this.skills.list();
  }

  getById(id: string): SkillRecord | null {
    return this.skills.getById(id);
  }

  setEnabled(id: string, enabled: boolean): SkillRecord | null {
    return this.skills.setEnabled(id, enabled);
  }

  async execute(
    skillId: string,
    input: unknown,
    context: Omit<SkillContext, "skill" | "state"> & {
      state?: SkillContext["state"];
    }
  ): Promise<unknown> {
    const definition = this.definitions.get(skillId);
    const skill = this.skills.getById(skillId);

    if (!definition || !skill) {
      throw new SkillNotFoundError(skillId);
    }

    if (!skill.enabled || definition.enabled === false) {
      throw new SkillDisabledError(skillId);
    }

    return definition.handler(input, {
      ...context,
      skill,
      state:
        context.state ??
        {
          get: (key) => this.state.get(key),
          set: (key, value) => this.state.set(key, JSON.stringify(redactSensitiveValue(value)))
        }
    });
  }
}

export class RoutineRegistry {
  private readonly routines;

  constructor(input: {
    database: DatabaseConnection;
  }) {
    this.routines = createRoutineRepository(input.database);
  }

  upsert(definition: RoutineDefinition): RoutineRecord {
    const normalized = normalizeRoutineDefinition(definition);

    return this.routines.upsert({
      id: normalized.id,
      name: normalized.name,
      description: normalized.description ?? null,
      stepsJson: JSON.stringify(normalized.steps),
      scheduleJson: normalized.schedule ? JSON.stringify(normalized.schedule) : null,
      enabled: normalized.enabled !== false
    });
  }

  getById(id: string): RoutineRecord | null {
    return this.routines.getById(id);
  }

  getDefinition(id: string): RoutineDefinition | null {
    const record = this.routines.getById(id);

    return record ? routineRecordToDefinition(record) : null;
  }

  list(): RoutineRecord[] {
    return this.routines.list();
  }

  setEnabled(id: string, enabled: boolean): RoutineRecord | null {
    return this.routines.setEnabled(id, enabled);
  }
}

export class RoutineRunner {
  private readonly routines: RoutineRegistry;
  private readonly skills: SkillRegistry;
  private readonly jobLogs;

  constructor(input: {
    routines: RoutineRegistry;
    skills: SkillRegistry;
    database: DatabaseConnection;
  }) {
    this.routines = input.routines;
    this.skills = input.skills;
    this.jobLogs = createJobLogRepository(input.database);
  }

  async run(
    routineId: string,
    input?: unknown,
    context: {
      jobId?: string | null;
      metadata?: JsonObject;
      visitedRoutineIds?: Set<string>;
    } = {}
  ): Promise<RoutineRunOutput> {
    const routine = this.routines.getDefinition(routineId);

    if (!routine) {
      throw new RoutineNotFoundError(routineId);
    }

    if (routine.enabled === false) {
      throw new RoutineDisabledError(routineId);
    }

    const visitedRoutineIds = context.visitedRoutineIds ?? new Set<string>();

    if (visitedRoutineIds.has(routine.id)) {
      throw new RoutineCycleError(routine.id);
    }

    visitedRoutineIds.add(routine.id);

    const outputs: RoutineRunOutput["outputs"] = [];

    for (const step of routine.steps) {
      const stepId = step.id ?? randomUUID();
      const stepInput = buildStepInput(step.input, input, outputs);
      const log = (level: JobLogLevel, message: string, metadata: JsonObject = {}) => {
        if (context.jobId) {
          this.jobLogs.record({
            jobId: context.jobId,
            level,
            message,
            metadataJson: JSON.stringify(redactSensitiveValue({ routineId, stepId, ...metadata }))
          });
        }
      };

      log("info", "routine.step.started", {
        type: step.type
      });

      if (step.type === "skill") {
        const result = await this.skills.execute(step.skillId, stepInput, {
          jobId: context.jobId ?? null,
          routineId,
          stepId,
          metadata: context.metadata,
          log
        });

        outputs.push({
          stepId,
          type: step.type,
          result
        });
        log("info", "routine.step.completed", {
          type: step.type
        });
        continue;
      }

      const result = await this.run(step.routineId, stepInput, {
        ...context,
        visitedRoutineIds
      });

      outputs.push({
        stepId,
        type: step.type,
        result
      });
      log("info", "routine.step.completed", {
        type: step.type
      });
    }

    visitedRoutineIds.delete(routine.id);

    return {
      routineId: routine.id,
      outputs
    };
  }
}

export class Scheduler {
  private readonly scheduledTasks;
  private readonly jobs;

  constructor(input: {
    database: DatabaseConnection;
  }) {
    this.scheduledTasks = createScheduledTaskRepository(input.database);
    this.jobs = createJobRepository(input.database);
  }

  scheduleRoutine(input: {
    routineId: string;
    name?: string;
    schedule: ScheduleDefinition;
    payload?: unknown;
    now?: Date;
  }): ScheduledTaskRecord {
    validateSchedule(input.schedule);
    const now = input.now ?? new Date();
    const nextRunAt = initialRunAt(input.schedule, now);

    return this.scheduledTasks.create({
      name: input.name ?? `Run ${input.routineId}`,
      routineId: input.routineId,
      jobType: "routine.run",
      inputJson: JSON.stringify({
        routineId: input.routineId,
        input: input.payload ?? null
      }),
      scheduleJson: JSON.stringify(input.schedule),
      nextRunAt: nextRunAt?.toISOString() ?? null,
      status: nextRunAt ? "active" : "completed"
    });
  }

  list(): ScheduledTaskRecord[] {
    return this.scheduledTasks.list();
  }

  cancel(id: string): ScheduledTaskRecord | null {
    return this.scheduledTasks.setStatus(id, "cancelled");
  }

  async runDueTasks(now = new Date()): Promise<JobRecord[]> {
    const dueTasks = this.scheduledTasks.listDue(now.toISOString());
    const jobs: JobRecord[] = [];

    for (const task of dueTasks) {
      const job = this.jobs.enqueue({
        type: task.jobType,
        routineId: task.routineId,
        inputJson: task.inputJson,
        availableAt: now.toISOString()
      });
      const schedule = parseJson<ScheduleDefinition>(task.scheduleJson, {
        type: "once",
        runAt: now.toISOString()
      });
      const nextRunAt = nextRunAfter(schedule, now);

      this.scheduledTasks.markTriggered({
        id: task.id,
        lastRunAt: now.toISOString(),
        nextRunAt: nextRunAt?.toISOString() ?? null
      });
      jobs.push(job);
    }

    return jobs;
  }
}

export class JobQueue {
  private readonly jobs;
  private readonly jobLogs;
  private readonly routineRunner: RoutineRunner;
  private readonly skills: SkillRegistry;
  private readonly retryDelayMs: number;

  constructor(input: {
    database: DatabaseConnection;
    routineRunner: RoutineRunner;
    skills: SkillRegistry;
    retryDelayMs: number;
  }) {
    this.jobs = createJobRepository(input.database);
    this.jobLogs = createJobLogRepository(input.database);
    this.routineRunner = input.routineRunner;
    this.skills = input.skills;
    this.retryDelayMs = input.retryDelayMs;
  }

  enqueueRoutine(input: {
    routineId: string;
    payload?: unknown;
    maxAttempts?: number;
  }): JobRecord {
    return this.jobs.enqueue({
      type: "routine.run",
      routineId: input.routineId,
      inputJson: JSON.stringify({
        routineId: input.routineId,
        input: input.payload ?? null
      }),
      maxAttempts: input.maxAttempts
    });
  }

  enqueueSkill(input: {
    skillId: string;
    payload?: unknown;
    maxAttempts?: number;
  }): JobRecord {
    return this.jobs.enqueue({
      type: "skill.run",
      skillId: input.skillId,
      inputJson: JSON.stringify({
        skillId: input.skillId,
        input: input.payload ?? null
      }),
      maxAttempts: input.maxAttempts
    });
  }

  list(input: { status?: JobStatus; limit?: number } = {}): JobRecord[] {
    return this.jobs.list(input);
  }

  logs(jobId: string): JobLogRecord[] {
    return this.jobLogs.listByJob(jobId);
  }

  stats(): Record<JobStatus, number> {
    return this.jobs.stats();
  }

  cancel(id: string): JobRecord | null {
    return this.jobs.cancel(id);
  }

  async processNext(now = new Date()): Promise<ProcessedJobResult | null> {
    const job = this.jobs.claimNext(now.toISOString());

    if (!job) {
      return null;
    }

    this.log(job.id, "info", "job.started", {
      type: job.type,
      attempt: job.attempts,
      maxAttempts: job.maxAttempts
    });

    try {
      const result = await this.executeJob(job);
      const completed = this.jobs.complete(job.id, JSON.stringify(redactSensitiveValue(result))) ?? job;

      this.log(job.id, "info", "job.completed", {
        status: completed.status
      });

      return {
        job: completed,
        result
      };
    } catch (error) {
      const safeError = serializeError(error);
      const retryAt =
        job.attempts < job.maxAttempts
          ? new Date(now.getTime() + this.retryDelayMs * Math.max(1, job.attempts)).toISOString()
          : null;
      const failed = this.jobs.fail({
        id: job.id,
        errorJson: JSON.stringify(safeError),
        retryAt
      }) ?? job;

      this.log(job.id, retryAt ? "warn" : "error", retryAt ? "job.retry_scheduled" : "job.failed", {
        error: safeError,
        retryAt
      });

      return {
        job: failed
      };
    }
  }

  async processAvailable(input: {
    limit?: number;
    now?: Date;
  } = {}): Promise<ProcessedJobResult[]> {
    const processed: ProcessedJobResult[] = [];
    const limit = input.limit ?? 1;
    const now = input.now ?? new Date();

    for (let index = 0; index < limit; index += 1) {
      const result = await this.processNext(now);

      if (!result) {
        break;
      }

      processed.push(result);
    }

    return processed;
  }

  private async executeJob(job: JobRecord): Promise<unknown> {
    if (job.type === "routine.run") {
      const payload = parseJson<{ routineId?: string; input?: unknown }>(job.inputJson, {});
      const routineId = job.routineId ?? payload.routineId;

      if (!routineId) {
        throw new RoutineNotFoundError("unknown");
      }

      return this.routineRunner.run(routineId, payload.input, {
        jobId: job.id,
        metadata: {
          jobType: job.type
        }
      });
    }

    if (job.type === "skill.run") {
      const payload = parseJson<{ skillId?: string; input?: unknown }>(job.inputJson, {});
      const skillId = job.skillId ?? payload.skillId;

      if (!skillId) {
        throw new SkillNotFoundError("unknown");
      }

      return this.skills.execute(skillId, payload.input, {
        jobId: job.id,
        metadata: {
          jobType: job.type
        },
        log: (level, message, metadata = {}) => this.log(job.id, level, message, metadata)
      });
    }

    throw new Error(`Unsupported job type: ${job.type}`);
  }

  private log(jobId: string, level: JobLogLevel, message: string, metadata: JsonObject = {}): void {
    this.jobLogs.record({
      jobId,
      level,
      message,
      metadataJson: JSON.stringify(redactSensitiveValue(metadata))
    });
  }
}

export class HeartbeatLoop {
  private readonly heartbeatEvents;
  private readonly state;
  private readonly scheduler: Scheduler;
  private readonly jobs: JobQueue;
  private readonly intervalMs: number;
  private readonly jobsPerHeartbeat: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private lastBeatAt: string | null = null;

  constructor(input: {
    database: DatabaseConnection;
    scheduler: Scheduler;
    jobs: JobQueue;
    intervalMs: number;
    jobsPerHeartbeat: number;
  }) {
    this.heartbeatEvents = createHeartbeatRepository(input.database);
    this.state = createAgentStateRepository(input.database);
    this.scheduler = input.scheduler;
    this.jobs = input.jobs;
    this.intervalMs = input.intervalMs;
    this.jobsPerHeartbeat = input.jobsPerHeartbeat;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.pulse();
    }, this.intervalMs);
    void this.pulse();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.inFlight) {
      await this.inFlight;
    }
  }

  async pulse(now = new Date()): Promise<HeartbeatEventRecord | null> {
    if (this.inFlight) {
      await this.inFlight;
      return null;
    }

    this.inFlight = this.runPulse(now);

    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }

    return this.heartbeatEvents.list(1)[0] ?? null;
  }

  status() {
    return {
      running: this.timer !== null,
      intervalMs: this.intervalMs,
      jobsPerHeartbeat: this.jobsPerHeartbeat,
      lastBeatAt: this.lastBeatAt
    };
  }

  private async runPulse(now: Date): Promise<void> {
    try {
      const enqueuedJobs = await this.scheduler.runDueTasks(now);
      const processedJobs = await this.jobs.processAvailable({
        limit: this.jobsPerHeartbeat,
        now
      });
      this.lastBeatAt = now.toISOString();
      this.state.set(
        "heartbeat.last",
        JSON.stringify({
          at: this.lastBeatAt,
          enqueuedJobs: enqueuedJobs.map((job) => job.id),
          processedJobs: processedJobs.map((item) => item.job.id),
          jobStats: this.jobs.stats()
        })
      );
      this.heartbeatEvents.record({
        status: "ok",
        payloadJson: JSON.stringify({
          enqueuedJobs: enqueuedJobs.length,
          processedJobs: processedJobs.length,
          jobStats: this.jobs.stats()
        })
      });
    } catch (error) {
      this.lastBeatAt = now.toISOString();
      this.heartbeatEvents.record({
        status: "error",
        payloadJson: JSON.stringify({
          error: serializeError(error)
        })
      });
    }
  }
}

export class AgentOS {
  readonly skills: SkillRegistry;
  readonly routines: RoutineRegistry;
  readonly scheduler: Scheduler;
  readonly jobs: JobQueue;
  readonly heartbeat: HeartbeatLoop;
  private readonly state;

  constructor(options: AgentOSOptions) {
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    const jobsPerHeartbeat = options.jobsPerHeartbeat ?? 5;
    const jobRetryDelayMs = options.jobRetryDelayMs ?? 60_000;
    this.state = createAgentStateRepository(options.database);
    this.skills = new SkillRegistry({
      database: options.database
    });
    this.routines = new RoutineRegistry({
      database: options.database
    });
    const routineRunner = new RoutineRunner({
      database: options.database,
      routines: this.routines,
      skills: this.skills
    });
    this.scheduler = new Scheduler({
      database: options.database
    });
    this.jobs = new JobQueue({
      database: options.database,
      routineRunner,
      skills: this.skills,
      retryDelayMs: jobRetryDelayMs
    });
    this.heartbeat = new HeartbeatLoop({
      database: options.database,
      scheduler: this.scheduler,
      jobs: this.jobs,
      intervalMs: heartbeatIntervalMs,
      jobsPerHeartbeat
    });
  }

  registerRoutine(definition: RoutineDefinition): RoutineRecord {
    const routine = this.routines.upsert(definition);

    if (definition.schedule) {
      this.scheduler.scheduleRoutine({
        routineId: definition.id,
        schedule: definition.schedule
      });
    }

    return routine;
  }

  start(): void {
    this.heartbeat.start();
  }

  async stop(): Promise<void> {
    await this.heartbeat.stop();
  }

  getState(key: string): AgentStateRecord | null {
    return this.state.get(key);
  }

  setState(key: string, value: unknown): AgentStateRecord {
    return this.state.set(key, JSON.stringify(redactSensitiveValue(value)));
  }

  status() {
    return {
      heartbeat: this.heartbeat.status(),
      jobs: this.jobs.stats(),
      skills: this.skills.list(),
      routines: this.routines.list()
    };
  }
}

export function createAgentOS(options: AgentOSOptions): AgentOS {
  return new AgentOS(options);
}

export const dailyPlanningSkill: SkillDefinition = {
  id: "planning.daily",
  name: "Daily planning",
  description: "Turns priorities and calendar notes into a compact local plan.",
  version: "0.1.0",
  permissions: [
    {
      resource: "agent_state",
      access: "write",
      scope: "planning"
    }
  ],
  handler(input, context) {
    const data = asRecord(input);
    const priorities = toStringArray(data.priorities);
    const calendar = toStringArray(data.calendar);
    const plan = [
      ...priorities.slice(0, 3).map((item, index) => `${index + 1}. ${item}`),
      ...calendar.slice(0, 2).map((item) => `Calendar: ${item}`)
    ];
    const result = {
      date: new Date().toISOString().slice(0, 10),
      plan: plan.length > 0 ? plan : ["Review inbox", "Pick one deep-work block", "Close the day with notes"],
      summary: "Daily plan generated from local routine input."
    };

    context.state.set("planning.last_daily_plan", result);
    context.log("info", "planning.daily.completed", {
      items: result.plan.length
    });

    return result;
  }
};

export const emailTriageSkill: SkillDefinition = {
  id: "email.triage",
  name: "Email triage",
  description: "Classifies local email-like items into respond, review, archive, and urgent buckets.",
  version: "0.1.0",
  permissions: [
    {
      resource: "email_metadata",
      access: "read",
      scope: "local-input"
    }
  ],
  handler(input) {
    const emails = Array.isArray(input) ? input : toArray(asRecord(input).emails);
    const buckets: Record<"urgent" | "respond" | "review" | "archive", unknown[]> = {
      urgent: [],
      respond: [],
      review: [],
      archive: []
    };

    for (const email of emails) {
      const subject = readString(asRecord(email).subject).toLowerCase();
      const body = readString(asRecord(email).body).toLowerCase();
      const text = `${subject} ${body}`;

      if (/(urgent|asap|blocked|today)/.test(text)) {
        buckets.urgent.push(email);
      } else if (/(question|reply|respond|confirm)/.test(text)) {
        buckets.respond.push(email);
      } else if (/(newsletter|receipt|no-reply|noreply)/.test(text)) {
        buckets.archive.push(email);
      } else {
        buckets.review.push(email);
      }
    }

    return {
      counts: Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, value.length])),
      buckets
    };
  }
};

export const webResearchSkill: SkillDefinition = {
  id: "research.web",
  name: "Web research planner",
  description: "Prepares an offline-safe research checklist and source questions.",
  version: "0.1.0",
  permissions: [
    {
      resource: "network",
      access: "read",
      scope: "operator-approved"
    }
  ],
  handler(input) {
    const data = asRecord(input);
    const query = readString(data.query || data.topic || "research topic");

    return {
      query,
      checklist: [
        `Identify primary sources for: ${query}`,
        "Capture claims, dates, authorship, and uncertainty.",
        "Summarize findings with links and local notes."
      ],
      sourceQuestions: [
        "What is the most authoritative source?",
        "What has changed recently?",
        "What should be verified before acting?"
      ]
    };
  }
};

export const fileOrganizationSkill: SkillDefinition = {
  id: "files.organize",
  name: "Local file organization",
  description: "Groups local file paths by extension and suggests target folders without moving files.",
  version: "0.1.0",
  permissions: [
    {
      resource: "workspace_files",
      access: "read",
      scope: "local-input"
    }
  ],
  handler(input) {
    const files = toStringArray(asRecord(input).files);
    const groups: Record<string, string[]> = {};

    for (const file of files) {
      const extension = file.includes(".") ? file.slice(file.lastIndexOf(".") + 1).toLowerCase() : "other";

      groups[extension] = [...(groups[extension] ?? []), file];
    }

    return {
      groups,
      suggestions: Object.keys(groups)
        .sort()
        .map((extension) => ({
          extension,
          targetFolder: extension === "md" || extension === "txt" ? "notes" : extension
        }))
    };
  }
};

export const exampleRoutines: RoutineDefinition[] = [
  {
    id: "routine.daily-planning",
    name: "Daily planning",
    description: "Create a compact plan for the day.",
    steps: [
      {
        id: "plan",
        type: "skill",
        skillId: "planning.daily",
        input: {
          priorities: ["Review active jobs", "Plan one focused work block", "Triage pending messages"]
        }
      }
    ]
  },
  {
    id: "routine.email-triage",
    name: "Email triage",
    description: "Classify local email-like input.",
    steps: [
      {
        id: "triage",
        type: "skill",
        skillId: "email.triage"
      }
    ]
  },
  {
    id: "routine.web-research",
    name: "Web research",
    description: "Prepare an offline-safe web research plan.",
    steps: [
      {
        id: "research-plan",
        type: "skill",
        skillId: "research.web"
      }
    ]
  },
  {
    id: "routine.file-organization",
    name: "Local file organization",
    description: "Suggest organization buckets for local file paths.",
    steps: [
      {
        id: "organize",
        type: "skill",
        skillId: "files.organize"
      }
    ]
  }
];

export function registerExampleSkills(registry: SkillRegistry): SkillRecord[] {
  return [dailyPlanningSkill, emailTriageSkill, webResearchSkill, fileOrganizationSkill].map((skill) =>
    registry.register(skill)
  );
}

export function registerExampleRoutines(agentOS: AgentOS): RoutineRecord[] {
  return exampleRoutines.map((routine) => agentOS.registerRoutine(routine));
}

export function validateSchedule(schedule: ScheduleDefinition): void {
  if (schedule.type === "once") {
    parseDate(schedule.runAt, "once schedule runAt is invalid.");
    return;
  }

  if (schedule.type === "interval") {
    if (!Number.isInteger(schedule.everySeconds) || schedule.everySeconds <= 0) {
      throw new ScheduleValidationError("Interval schedules require a positive everySeconds value.");
    }

    if (schedule.startAt) {
      parseDate(schedule.startAt, "interval schedule startAt is invalid.");
    }

    return;
  }

  if (schedule.type === "cron") {
    parseCronExpression(schedule.expression);

    if (schedule.startAt) {
      parseDate(schedule.startAt, "cron schedule startAt is invalid.");
    }

    return;
  }

  throw new ScheduleValidationError("Unknown schedule type.");
}

export function nextRunAfter(schedule: ScheduleDefinition, after = new Date()): Date | null {
  validateSchedule(schedule);

  if (schedule.type === "once") {
    return null;
  }

  if (schedule.type === "interval") {
    const intervalMs = schedule.everySeconds * 1000;
    const startAt = schedule.startAt ? parseDate(schedule.startAt) : after;

    if (startAt.getTime() > after.getTime()) {
      return startAt;
    }

    const elapsed = after.getTime() - startAt.getTime();
    const intervals = Math.floor(elapsed / intervalMs) + 1;

    return new Date(startAt.getTime() + intervals * intervalMs);
  }

  return nextCronRun(schedule.expression, schedule.startAt ? maxDate(after, parseDate(schedule.startAt)) : after);
}

function initialRunAt(schedule: ScheduleDefinition, now: Date): Date | null {
  validateSchedule(schedule);

  if (schedule.type === "once") {
    return parseDate(schedule.runAt);
  }

  return nextRunAfter(schedule, now);
}

function normalizeRoutineDefinition(definition: RoutineDefinition): RoutineDefinition {
  assertNonEmpty(definition.id, "Routine id is required.");
  assertNonEmpty(definition.name, "Routine name is required.");

  if (!Array.isArray(definition.steps)) {
    throw new Error("Routine steps must be an array.");
  }

  if (definition.schedule) {
    validateSchedule(definition.schedule);
  }

  return {
    ...definition,
    steps: definition.steps.map((step, index) => ({
      ...step,
      id: step.id ?? `step-${index + 1}`
    }))
  };
}

function routineRecordToDefinition(record: RoutineRecord): RoutineDefinition {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    steps: parseJson<RoutineStep[]>(record.stepsJson, []),
    schedule: record.scheduleJson ? parseJson<ScheduleDefinition | null>(record.scheduleJson, null) : null,
    enabled: record.enabled
  };
}

function buildStepInput(stepInput: unknown, routineInput: unknown, previousResults: RoutineRunOutput["outputs"]): unknown {
  if (stepInput === undefined) {
    return {
      routineInput,
      previousResults: snapshotPreviousResults(previousResults)
    };
  }

  if (isRecord(stepInput)) {
    return {
      ...stepInput,
      routineInput,
      previousResults: snapshotPreviousResults(previousResults)
    };
  }

  return stepInput;
}

function snapshotPreviousResults(previousResults: RoutineRunOutput["outputs"]): RoutineRunOutput["outputs"] {
  return previousResults.map((result) => ({
    stepId: result.stepId,
    type: result.type,
    result: result.result
  }));
}

function parseDate(value: string, message = "Invalid date."): Date {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new ScheduleValidationError(message);
  }

  return date;
}

function nextCronRun(expression: string, after: Date): Date {
  const cron = parseCronExpression(expression);
  const cursor = new Date(after.getTime() + 60_000);

  cursor.setUTCSeconds(0, 0);

  for (let index = 0; index < 366 * 24 * 60; index += 1) {
    if (cronMatches(cursor, cron)) {
      return new Date(cursor);
    }

    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }

  throw new ScheduleValidationError("Cron expression did not produce a run within one year.");
}

function parseCronExpression(expression: string): CronExpression {
  const parts = expression.trim().split(/\s+/);

  if (parts.length !== 5) {
    throw new ScheduleValidationError("Cron schedules must use five fields: minute hour day month weekday.");
  }

  return {
    minute: parseCronField(parts[0] ?? "", 0, 59),
    hour: parseCronField(parts[1] ?? "", 0, 23),
    dayOfMonth: parseCronField(parts[2] ?? "", 1, 31),
    month: parseCronField(parts[3] ?? "", 1, 12),
    dayOfWeek: parseCronField(parts[4] ?? "", 0, 7)
  };
}

type CronExpression = {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
};

function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    if (part === "*") {
      addRange(values, min, max, 1);
      continue;
    }

    if (part.startsWith("*/")) {
      const step = Number.parseInt(part.slice(2), 10);

      if (!Number.isInteger(step) || step <= 0) {
        throw new ScheduleValidationError(`Invalid cron step: ${part}`);
      }

      addRange(values, min, max, step);
      continue;
    }

    const value = Number.parseInt(part, 10);

    if (!Number.isInteger(value) || value < min || value > max) {
      throw new ScheduleValidationError(`Invalid cron field value: ${part}`);
    }

    values.add(value);
  }

  return values;
}

function addRange(values: Set<number>, min: number, max: number, step: number): void {
  for (let value = min; value <= max; value += step) {
    values.add(value);
  }
}

function cronMatches(date: Date, cron: CronExpression): boolean {
  const dayOfWeek = date.getUTCDay();

  return (
    cron.minute.has(date.getUTCMinutes()) &&
    cron.hour.has(date.getUTCHours()) &&
    cron.dayOfMonth.has(date.getUTCDate()) &&
    cron.month.has(date.getUTCMonth() + 1) &&
    (cron.dayOfWeek.has(dayOfWeek) || (dayOfWeek === 0 && cron.dayOfWeek.has(7)))
  );
}

function maxDate(left: Date, right: Date): Date {
  return left.getTime() >= right.getTime() ? left : right;
}

function assertNonEmpty(value: string, message: string): void {
  if (value.trim() === "") {
    throw new Error(message);
  }
}

function serializeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return redactSensitiveValue({
      name: error.name,
      message: error.message
    });
  }

  return {
    name: "Error",
    message: "Unknown job error."
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function asRecord(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
