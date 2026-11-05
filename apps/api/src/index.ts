import { loadConfig } from "@openclaw/config";
import { initializeDatabase } from "@openclaw/db";

import { buildServer } from "./server.js";

const config = loadConfig();
const initializedDatabase = initializeDatabase();
const server = await buildServer({
  config,
  database: initializedDatabase.database
});

server.addHook("onClose", () => {
  initializedDatabase.database.close();
});

if (initializedDatabase.migrations.applied.length > 0) {
  server.log.info({ migrations: initializedDatabase.migrations.applied }, "database initialized");
}

try {
  await server.listen({
    host: config.server.host,
    port: config.server.port
  });
} catch (error) {
  server.log.error(error);
  process.exit(1);
}
