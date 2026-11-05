import { initializeDatabase } from "./index.js";

const { database, migrations } = initializeDatabase();

try {
  const suffix = migrations.applied.length === 0 ? "no new migrations" : migrations.applied.join(", ");
  console.log(`Database migrated: ${suffix}`);
} finally {
  database.close();
}
