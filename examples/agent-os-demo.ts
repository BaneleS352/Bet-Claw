import { createAgentOS, registerExampleRoutines, registerExampleSkills } from "@openclaw/agent-os";
import { initializeDatabase } from "@openclaw/db";

async function main(): Promise<void> {
  const { database, migrations } = initializeDatabase("data/agent-os-demo.sqlite");

  try {
    const agentOS = createAgentOS({
      database,
      heartbeatIntervalMs: 5_000,
      jobsPerHeartbeat: 5,
      jobRetryDelayMs: 1_000
    });

    registerExampleSkills(agentOS.skills);
    registerExampleRoutines(agentOS);

    const routineJob = agentOS.jobs.enqueueRoutine({
      routineId: "routine.daily-planning",
      payload: {
        priorities: ["Review scheduled tasks", "Process pending jobs", "Write a shutdown note"]
      }
    });

    await agentOS.jobs.processAvailable({
      limit: 1
    });

    agentOS.scheduler.scheduleRoutine({
      routineId: "routine.file-organization",
      name: "Demo file organization",
      schedule: {
        type: "once",
        runAt: new Date().toISOString()
      },
      payload: {
        files: ["notes/today.md", "downloads/report.pdf", "screenshots/ui.png"]
      }
    });

    await agentOS.heartbeat.pulse();

    console.log(
      JSON.stringify(
        {
          migrations: migrations.applied,
          firstJob: routineJob.id,
          status: agentOS.status(),
          firstJobLogs: agentOS.jobs.logs(routineJob.id)
        },
        null,
        2
      )
    );
  } finally {
    database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
