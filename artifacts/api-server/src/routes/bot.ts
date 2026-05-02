import { Router, type IRouter } from "express";
import { startBot, stopBot, clickAt, typeText, pressKey, getBotStatus, getLatestScreenshot, setAutoRestart } from "../lib/bot";
import {
  GetBotStatusResponse,
  StartBotResponse,
  StopBotResponse,
  BotClickBody,
  BotClickResponse,
  BotTypeBody,
  BotTypeResponse,
  GetBotScreenshotResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/bot/status", async (_req, res): Promise<void> => {
  const status = getBotStatus();
  const parsed = GetBotStatusResponse.parse(status);
  res.json(parsed);
});

router.post("/bot/start", async (req, res): Promise<void> => {
  const result = await startBot();
  res.json(StartBotResponse.parse(result));
});

router.post("/bot/stop", async (req, res): Promise<void> => {
  const result = await stopBot();
  res.json(StopBotResponse.parse(result));
});

router.post("/bot/restart", async (_req, res): Promise<void> => {
  await stopBot();
  const result = await startBot();
  res.json(StartBotResponse.parse(result));
});

router.post("/bot/click", async (req, res): Promise<void> => {
  const parsed = BotClickBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const result = await clickAt(parsed.data.x, parsed.data.y);
  res.json(BotClickResponse.parse(result));
});

router.post("/bot/type", async (req, res): Promise<void> => {
  const parsed = BotTypeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const result = await typeText(parsed.data.text);
  res.json(BotTypeResponse.parse(result));
});

router.get("/bot/screenshot", async (_req, res): Promise<void> => {
  const data = getLatestScreenshot();
  res.json(GetBotScreenshotResponse.parse(data));
});

router.post("/bot/auto-restart", async (req, res): Promise<void> => {
  const { enabled } = req.body;
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be a boolean" });
    return;
  }
  setAutoRestart(enabled);
  res.json({ success: true, autoRestart: enabled });
});

export default router;
