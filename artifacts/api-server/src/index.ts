import app from "./app";
import { logger } from "./lib/logger";
import { restoreSessionFromEnv } from "./lib/bot";
import { restoreAutoLoginConfigFromEnv } from "./lib/auto-login";

// Restore persisted data from Render env vars before anything else starts,
// so credentials and sessions survive fresh deploys.
restoreSessionFromEnv();
restoreAutoLoginConfigFromEnv();

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
