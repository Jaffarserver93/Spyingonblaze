import { Router, type IRouter } from "express";
import { loadConfig, saveConfig, testImap, getAutoLoginState } from "../lib/auto-login";

const router: IRouter = Router();

router.get("/auto-login/config", (_req, res): void => {
  const state = getAutoLoginState();
  res.json(state);
});

router.post("/auto-login/config", (req, res): void => {
  const { email, password, imapHost, imapPort, imapUser, imapPassword } = req.body;
  if (!email || !password || !imapHost || !imapPort || !imapPassword) {
    res.status(400).json({ success: false, message: "Missing required fields" });
    return;
  }
  saveConfig({ email, password, imapHost, imapPort: Number(imapPort), imapUser: imapUser ?? "", imapPassword });
  res.json({ success: true, message: "Credentials saved" });
});

router.post("/auto-login/test-imap", async (req, res): Promise<void> => {
  const { imapHost, imapPort, imapUser, imapPassword, email } = req.body;
  if (!imapHost || !imapPort || !imapPassword) {
    res.status(400).json({ success: false, message: "Missing IMAP fields" });
    return;
  }
  const user = imapUser?.trim() || email;
  const result = await testImap(imapHost, Number(imapPort), user, imapPassword);
  res.json(result);
});

router.delete("/auto-login/config", (_req, res): void => {
  const fs = require("fs");
  const path = require("path");
  const cfgFile = path.resolve(process.cwd(), "auto-login-config.json");
  try {
    if (fs.existsSync(cfgFile)) fs.unlinkSync(cfgFile);
    res.json({ success: true, message: "Credentials cleared" });
  } catch {
    res.status(500).json({ success: false, message: "Failed to clear credentials" });
  }
});

export default router;
