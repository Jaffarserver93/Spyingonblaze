import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import { existsSync } from "fs";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// In production (Render), serve the built React dashboard as static files
if (process.env.NODE_ENV === "production") {
  const publicDir = path.resolve(process.cwd(), "artifacts/bot-dashboard/dist/public");
  if (existsSync(publicDir)) {
    app.use(express.static(publicDir));
    app.get("/{*splat}", (_req, res) => {
      res.sendFile(path.join(publicDir, "index.html"));
    });
    logger.info({ publicDir }, "Serving static frontend");
  }
}

export default app;
