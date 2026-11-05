import { describe, expect, it } from "vitest";

import { migrate, openDatabase } from "@openclaw/db";

import {
  createAgentOS,
  nextRunAfter,
  registerExampleRoutines,
  registerExampleSkills,
  type SkillDefinition
} from "./index.js";

describe("Agent OS", () => {
  it("registers skills and runs a reusable routine through the job queue", async () => {
    const database = openDatabase(":memory:");

    try {
      migrate(database);
      const agentOS = createAgentOS({
        database,
        jobRetryDelayMs: 0
      });

      agentOS.skills.register({
        id: "test.echo",
        name: "Echo",
        version: "0.1.0",
        handler(input) {
          return {
            echoed: input
          };
        }
      });
      agentOS.registerRoutine({
        id: "routine.echo",
        name: "Echo routine",
        steps: [
          {
            id: "echo",
            type: "skill",
            skillId: "test.echo",
            input: {
              message: "hello"
            }
          }
        ]
      });

      const job = agentOS.jobs.enqueueRoutine({
        routineId: "routine.echo"
      });
      const processed = await agentOS.jobs.processAvailable();
      const logs = agentOS.jobs.logs(job.id);

      expect(processed).toHaveLength(1);
      expect(processed[0]?.job.status).toBe("completed");
      expect(JSON.stringify(processed[0]?.result)).toContain("hello");
      expect(logs.map((log) => log.message)).toEqual(
        expect.arrayContaining(["job.started", "routine.step.completed", "job.completed"])
      );
    } finally {
      database.close();
    }
  });

  it("schedules due routines and processes them from the heartbeat", async () => {
    const database = openDatabase(":memory:");

    try {
      migrate(database);
      const agentOS = createAgentOS({
        database,
        heartbeatIntervalMs: 1_000,
        jobsPerHeartbeat: 5,
        jobRetryDelayMs: 0
      });

      agentOS.skills.register({
        id: "test.state",
        name: "State writer",
        version: "0.1.0",
        handler(input, context) {
          context.state.set("test.last_input", input);

          return {
            stored: true
          };
        }
      });
      agentOS.registerRoutine({
        id: "routine.state",
        name: "State routine",
        steps: [
          {
            type: "skill",
            skillId: "test.state"
          }
        ]
      });
      agentOS.scheduler.scheduleRoutine({
        routineId: "routine.state",
        schedule: {
          type: "once",
          runAt: "2026-01-01T00:00:00.000Z"
        },
        payload: {
          source: "heartbeat-test"
        },
        now: new Date("2026-05-19T00:00:00.000Z")
      });

      const heartbeat = await agentOS.heartbeat.pulse(new Date("2026-05-19T00:00:00.000Z"));
      const state = agentOS.getState("heartbeat.last");

      expect(heartbeat?.status).toBe("ok");
      expect(agentOS.jobs.stats().completed).toBe(1);
      expect(state?.valueJson).toContain("processedJobs");
      expect(agentOS.getState("test.last_input")?.valueJson).toContain("heartbeat-test");
    } finally {
      database.close();
    }
  });

  it("retries failed jobs before marking them failed", async () => {
    const database = openDatabase(":memory:");

    try {
      migrate(database);
      const agentOS = createAgentOS({
        database,
        jobRetryDelayMs: 0
      });
      const failingSkill: SkillDefinition = {
        id: "test.fail",
        name: "Fail",
        version: "0.1.0",
        handler() {
          throw new Error("planned failure");
        }
      };

      agentOS.skills.register(failingSkill);
      const job = agentOS.jobs.enqueueSkill({
        skillId: "test.fail",
        maxAttempts: 2
      });

      const firstAttempt = await agentOS.jobs.processNext();
      const secondAttempt = await agentOS.jobs.processNext();
      const logs = agentOS.jobs.logs(job.id);

      expect(firstAttempt?.job.status).toBe("pending");
      expect(firstAttempt?.job.attempts).toBe(1);
      expect(secondAttempt?.job.status).toBe("failed");
      expect(secondAttempt?.job.attempts).toBe(2);
      expect(logs.map((log) => log.message)).toEqual(
        expect.arrayContaining(["job.retry_scheduled", "job.failed"])
      );
    } finally {
      database.close();
    }
  });

  it("registers the platform example skills and routines", () => {
    const database = openDatabase(":memory:");

    try {
      migrate(database);
      const agentOS = createAgentOS({
        database
      });

      registerExampleSkills(agentOS.skills);
      registerExampleRoutines(agentOS);

      expect(agentOS.skills.list().map((skill) => skill.id)).toEqual(
        expect.arrayContaining(["planning.daily", "email.triage", "research.web", "files.organize"])
      );
      expect(agentOS.routines.list().map((routine) => routine.id)).toEqual(
        expect.arrayContaining([
          "routine.daily-planning",
          "routine.email-triage",
          "routine.web-research",
          "routine.file-organization"
        ])
      );
    } finally {
      database.close();
    }
  });

  it("computes interval and cron next runs", () => {
    expect(
      nextRunAfter(
        {
          type: "interval",
          everySeconds: 60,
          startAt: "2026-05-19T00:00:00.000Z"
        },
        new Date("2026-05-19T00:02:30.000Z")
      )?.toISOString()
    ).toBe("2026-05-19T00:03:00.000Z");
    expect(
      nextRunAfter(
        {
          type: "cron",
          expression: "*/15 * * * *"
        },
        new Date("2026-05-19T00:01:00.000Z")
      )?.toISOString()
    ).toBe("2026-05-19T00:15:00.000Z");
  });
});
