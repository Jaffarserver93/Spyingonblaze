import fs from "fs";
import path from "path";
import { ImapFlow } from "imapflow";
import type { Page } from "puppeteer";
import { logger } from "./logger";

const CONFIG_FILE = path.resolve(process.cwd(), "auto-login-config.json");
const MAX_LOG_ENTRIES = 100;

export interface AutoLoginConfig {
  email: string;
  password: string;
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPassword: string;
}

export interface AutoLoginLogEntry {
  time: string;
  message: string;
  type: "info" | "success" | "warning" | "error";
}

interface AutoLoginState {
  configured: boolean;
  active: boolean;
  currentStep: string | null;
  log: AutoLoginLogEntry[];
  lastAttempt: string | null;
}

const state: AutoLoginState = {
  configured: false,
  active: false,
  currentStep: null,
  log: [],
  lastAttempt: null,
};

function addLog(message: string, type: AutoLoginLogEntry["type"] = "info") {
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  state.log.unshift({ time, message, type });
  if (state.log.length > MAX_LOG_ENTRIES) state.log.length = MAX_LOG_ENTRIES;
  logger.info({ autoLogin: true }, message);
}

// ─── Config persistence ───────────────────────────────────────────────────────

export function loadConfig(): AutoLoginConfig | null {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    return JSON.parse(raw) as AutoLoginConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: AutoLoginConfig): void {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  state.configured = true;
  addLog(`Credentials saved for ${config.email}`, "success");
}

export function getAutoLoginState() {
  const cfg = loadConfig();
  return {
    configured: cfg !== null,
    active: state.active,
    currentStep: state.currentStep,
    log: state.log,
    lastAttempt: state.lastAttempt,
    email: cfg?.email ?? null,
    imapHost: cfg?.imapHost ?? "imap.gmail.com",
    imapPort: cfg?.imapPort ?? 993,
    imapUser: cfg?.imapUser ?? "",
  };
}

// ─── IMAP OTP fetching ────────────────────────────────────────────────────────

export async function testImap(
  host: string,
  port: number,
  user: string,
  password: string,
): Promise<{ success: boolean; message: string }> {
  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass: password },
    logger: false,
    tls: { rejectUnauthorized: false },
  });
  try {
    await client.connect();
    await client.logout();
    return { success: true, message: "IMAP connection successful" };
  } catch (err) {
    return {
      success: false,
      message: `IMAP connection failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function fetchOtpFromImap(): Promise<string | null> {
  const cfg = loadConfig();
  if (!cfg) return null;

  const imapUser = cfg.imapUser?.trim() || cfg.email;

  const client = new ImapFlow({
    host: cfg.imapHost,
    port: cfg.imapPort,
    secure: true,
    auth: { user: imapUser, pass: cfg.imapPassword },
    logger: false,
    tls: { rejectUnauthorized: false },
  });

  try {
    addLog("Connecting to IMAP to fetch OTP...", "info");
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");

    try {
      // Search for recent unseen emails in the last 10 minutes
      const since = new Date(Date.now() - 10 * 60 * 1000);
      const messages = await client.search({ since, seen: false });

      if (!messages || messages.length === 0) {
        addLog("No new emails found for OTP", "warning");
        return null;
      }

      // Fetch the most recent messages and look for OTP
      const uids = messages.slice(-5);
      for (const uid of uids.reverse()) {
        const msg = await client.fetchOne(String(uid), { source: true });
        if (!msg) continue;

        const raw = msg.source?.toString() ?? "";
        // Look for 6-digit OTP code in email body
        const otpMatch = raw.match(/\b(\d{6})\b/);
        if (otpMatch) {
          addLog(`OTP found: ${otpMatch[1]}`, "success");
          await client.logout();
          return otpMatch[1];
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();
    addLog("No OTP code found in recent emails", "warning");
    return null;
  } catch (err) {
    addLog(`IMAP error: ${err instanceof Error ? err.message : String(err)}`, "error");
    try { await client.logout(); } catch {}
    return null;
  }
}

// ─── Page detection helpers ───────────────────────────────────────────────────

async function detectLoginStep(page: Page): Promise<"email" | "password" | "otp" | "none"> {
  try {
    return await page.evaluate(() => {
      const url = window.location.href;

      // OTP / factor-two
      if (
        url.includes("factor-two") ||
        document.querySelector("input[data-input-otp]") ||
        document.querySelector("[class*='otpCode']") ||
        document.querySelector("[class*='OtpCode']") ||
        document.querySelector("input[autocomplete='one-time-code']")
      ) {
        return "otp";
      }

      // Password / factor-one
      if (
        url.includes("factor-one") ||
        document.querySelector("input[type='password']") ||
        document.querySelector("input[name='password']") ||
        document.querySelector("#password-field")
      ) {
        return "password";
      }

      // Email input
      if (
        document.querySelector("input[name='identifier']") ||
        document.querySelector("input[type='email']") ||
        document.querySelector("#identifier-field") ||
        (document.querySelector("input[type='text']") &&
          (window.location.href.includes("sign-in") ||
            window.location.href === "https://dash.blazenode.online/" ||
            document.title?.toLowerCase().includes("sign in")))
      ) {
        return "email";
      }

      return "none";
    });
  } catch {
    return "none";
  }
}

// ─── Auto-login step executor ─────────────────────────────────────────────────

let autoLoginLock = false;
let lastLoginAttemptAt = 0;
const LOGIN_COOLDOWN_MS = 15_000;

export async function runAutoLoginStep(page: Page): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) return;
  if (autoLoginLock) return;
  if (Date.now() - lastLoginAttemptAt < LOGIN_COOLDOWN_MS) return;

  const step = await detectLoginStep(page);
  if (step === "none") return;

  autoLoginLock = true;
  lastLoginAttemptAt = Date.now();
  state.active = true;
  state.lastAttempt = new Date().toISOString();

  try {
    if (step === "email") {
      state.currentStep = "email";
      addLog("Auto-login: Detected email step", "info");
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});

      // Try to fill the email field
      const emailSelector =
        "input[name='identifier'], input[type='email'], #identifier-field, input[type='text']";
      await page.waitForSelector(emailSelector, { timeout: 5000 });
      await page.click(emailSelector);
      await page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLInputElement | null;
        if (el) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); }
      }, emailSelector);
      await page.type(emailSelector, cfg.email, { delay: 60 });
      addLog(`Typed email: ${cfg.email}`, "info");
      await new Promise((r) => setTimeout(r, 600));

      // Click the plain Continue / Next / Sign in button — skip all social login buttons
      const clicked = await page.evaluate(() => {
        // Social provider keywords to skip
        const SOCIAL = ["google", "github", "apple", "facebook", "twitter", "microsoft", "saml", "oauth", "gitlab", "linkedin", "discord"];

        // Prefer submit buttons first (Clerk uses type="submit" for the main action)
        const submitBtns = Array.from(document.querySelectorAll<HTMLButtonElement>("button[type='submit']"));
        for (const btn of submitBtns) {
          const t = (btn.textContent ?? "").toLowerCase();
          if (SOCIAL.some((s) => t.includes(s))) continue;
          if (!btn.disabled) { btn.click(); return "submit-btn"; }
        }

        // Fallback: any button whose text is purely "continue", "next", or "sign in" (no social keywords)
        const allBtns = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
        for (const btn of allBtns) {
          const t = (btn.textContent ?? "").toLowerCase().trim();
          if (SOCIAL.some((s) => t.includes(s))) continue;
          if (t === "continue" || t === "next" || t === "sign in" || t === "continue →") {
            if (!btn.disabled) { btn.click(); return "text-btn"; }
          }
        }
        return null;
      });
      if (!clicked) {
        // Safest fallback: press Enter on the focused email field
        await page.keyboard.press("Enter");
      }
      addLog(`Clicked Continue after email (method: ${clicked ?? "Enter"})`, "info");
    } else if (step === "password") {
      state.currentStep = "password";
      addLog("Auto-login: Detected password step", "info");
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});

      const pwdSelector = "input[type='password'], input[name='password'], #password-field";
      await page.waitForSelector(pwdSelector, { timeout: 5000 });
      await page.click(pwdSelector);
      await page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLInputElement | null;
        if (el) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); }
      }, pwdSelector);
      await page.type(pwdSelector, cfg.password, { delay: 60 });
      addLog("Typed password", "info");
      await new Promise((r) => setTimeout(r, 600));

      const clickedPwd = await page.evaluate(() => {
        const SOCIAL = ["google", "github", "apple", "facebook", "twitter", "microsoft", "saml", "oauth", "gitlab", "linkedin", "discord"];

        const submitBtns = Array.from(document.querySelectorAll<HTMLButtonElement>("button[type='submit']"));
        for (const btn of submitBtns) {
          const t = (btn.textContent ?? "").toLowerCase();
          if (SOCIAL.some((s) => t.includes(s))) continue;
          if (!btn.disabled) { btn.click(); return "submit-btn"; }
        }

        const allBtns = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
        for (const btn of allBtns) {
          const t = (btn.textContent ?? "").toLowerCase().trim();
          if (SOCIAL.some((s) => t.includes(s))) continue;
          if (t === "continue" || t === "next" || t === "sign in" || t === "continue →") {
            if (!btn.disabled) { btn.click(); return "text-btn"; }
          }
        }
        return null;
      });
      if (!clickedPwd) await page.keyboard.press("Enter");
      addLog(`Clicked Continue after password (method: ${clickedPwd ?? "Enter"})`, "info");
    } else if (step === "otp") {
      state.currentStep = "otp";
      addLog("Auto-login: Detected OTP step — fetching from email...", "info");

      // Wait a moment for the OTP email to arrive
      await new Promise((r) => setTimeout(r, 3000));

      const otp = await fetchOtpFromImap();
      if (!otp) {
        addLog("Could not retrieve OTP from email", "error");
        state.active = false;
        autoLoginLock = false;
        return;
      }

      // Try multiple strategies to enter the OTP
      addLog(`OTP strategy A (paste): pasted_on:true`, "info");

      // Strategy A: find OTP input and set value
      const pastedA = await page.evaluate((code: string) => {
        const inputs = Array.from(document.querySelectorAll(
          "input[autocomplete='one-time-code'], input[data-input-otp], [class*='otpCode'] input, [class*='OtpCode'] input"
        )) as HTMLInputElement[];

        if (inputs.length === 1) {
          inputs[0].value = code;
          inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
          inputs[0].dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
        return false;
      }, otp);

      if (!pastedA) {
        // Strategy B: focus first OTP box and type digit by digit
        addLog("OTP strategy B: focus + keyboard.type (single=true)...", "info");
        const otpSelectors = [
          "input[autocomplete='one-time-code']",
          "input[data-input-otp]",
          "[class*='otpCode'] input",
          "input[maxlength='1']",
        ];
        for (const sel of otpSelectors) {
          const found = await page.$(sel);
          if (found) {
            await found.click();
            await page.keyboard.type(otp, { delay: 80 });
            addLog("OTP strategy B: typed OTP digit by digit", "info");
            break;
          }
        }
      }

      // Strategy C: mouse click on OTP field area then type
      addLog("OTP strategy C: mouse click + type...", "info");
      const otpBox = await page.$("input[autocomplete='one-time-code'], input[data-input-otp], input[maxlength='1']");
      if (otpBox) {
        const box = await otpBox.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          await page.keyboard.type(otp, { delay: 80 });
        }
      }

      await new Promise((r) => setTimeout(r, 800));

      // Submit
      const clicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        for (const btn of btns) {
          const t = (btn.textContent ?? "").toLowerCase().trim();
          if (t.includes("continue") || t.includes("verify") || t.includes("confirm")) {
            (btn as HTMLElement).click();
            return true;
          }
        }
        return false;
      });
      if (!clicked) await page.keyboard.press("Enter");
      addLog("OTP submitted — waiting for auth...", "info");
    }

    await new Promise((r) => setTimeout(r, 2000));

    // Check if we made it past login
    const finalStep = await detectLoginStep(page);
    if (finalStep === "none") {
      state.currentStep = null;
      addLog("Auto-login completed successfully!", "success");
    }
  } catch (err) {
    addLog(`Auto-login error: ${err instanceof Error ? err.message : String(err)}`, "error");
  } finally {
    state.active = false;
    autoLoginLock = false;
  }
}
