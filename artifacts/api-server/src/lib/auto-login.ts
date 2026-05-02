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
    imapPasswordSaved: !!cfg?.imapPassword,
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

// ─── Shared: click non-social submit button ───────────────────────────────────

function clickContinueScript(): string {
  return `(() => {
    const SOCIAL = ["google","github","apple","facebook","twitter","microsoft","saml","oauth","gitlab","linkedin","discord"];
    const submitBtns = Array.from(document.querySelectorAll('button[type="submit"]'));
    for (const btn of submitBtns) {
      const t = (btn.textContent || "").toLowerCase();
      if (SOCIAL.some(s => t.includes(s))) continue;
      if (!btn.disabled) { btn.click(); return "submit-btn"; }
    }
    const allBtns = Array.from(document.querySelectorAll("button"));
    for (const btn of allBtns) {
      const t = (btn.textContent || "").toLowerCase().trim();
      if (SOCIAL.some(s => t.includes(s))) continue;
      if (["continue","next","sign in","continue →"].includes(t)) {
        if (!btn.disabled) { btn.click(); return "text-btn"; }
      }
    }
    return null;
  })()`;
}

// ─── Auto-login step executor ─────────────────────────────────────────────────

let autoLoginLock = false;
let lastLoginAttemptAt = 0;
let lastCompletedStep: string | null = null;
let lastCompletedStepAt = 0;
const LOGIN_COOLDOWN_MS = 30_000;
const STEP_REPEAT_COOLDOWN_MS = 45_000;

export async function runAutoLoginStep(page: Page): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) return;
  if (autoLoginLock) return;
  if (Date.now() - lastLoginAttemptAt < LOGIN_COOLDOWN_MS) return;

  // Grab URL for logging before we do anything
  const currentUrl = await page.evaluate(() => window.location.href).catch(() => "unknown");

  const step = await detectLoginStep(page);
  if (step === "none") return;

  // Don't repeat the exact same step within STEP_REPEAT_COOLDOWN_MS
  if (step === lastCompletedStep && Date.now() - lastCompletedStepAt < STEP_REPEAT_COOLDOWN_MS) {
    addLog(`Skipping re-run of "${step}" step (cooldown active)`, "warning");
    return;
  }

  autoLoginLock = true;
  lastLoginAttemptAt = Date.now();
  state.active = true;
  state.lastAttempt = new Date().toISOString();
  addLog(`Auto-login: step="${step}" url=${currentUrl}`, "info");

  try {
    if (step === "email") {
      state.currentStep = "email";
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});

      const emailSelector = "input[name='identifier'], input[type='email'], #identifier-field";
      await page.waitForSelector(emailSelector, { timeout: 5000 });

      // Clear and fill
      await page.evaluate((sel, email) => {
        const el = document.querySelector(sel) as HTMLInputElement | null;
        if (!el) return;
        el.focus();
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, emailSelector, cfg.email);
      await page.click(emailSelector);
      await page.keyboard.down("Control");
      await page.keyboard.press("a");
      await page.keyboard.up("Control");
      await page.type(emailSelector, cfg.email, { delay: 60 });
      addLog(`Typed email: ${cfg.email}`, "info");
      await new Promise((r) => setTimeout(r, 800));

      const clicked = await page.evaluate(new Function(`return ${clickContinueScript()}`) as () => string | null);
      if (!clicked) await page.keyboard.press("Enter");
      addLog(`Continue after email (method: ${clicked ?? "Enter"})`, "info");

    } else if (step === "password") {
      state.currentStep = "password";
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});

      // ── Clerk "Welcome back" page: email + password on same form ──────────
      // The email field may LOOK pre-filled but its .value is empty.
      // Always ensure the email field has the correct value before submitting.
      const emailOnPwdPage = await page.evaluate((email: string) => {
        const emailSels = ["input[name='identifier']", "input[type='email']", "#identifier-field"];
        for (const sel of emailSels) {
          const el = document.querySelector(sel) as HTMLInputElement | null;
          if (!el) continue;
          if (!el.value || el.value.trim() === "") {
            // Field is present but empty — fill it
            el.focus();
            el.value = email;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return `filled-email:${sel}`;
          }
          return `email-already-set:${el.value}`;
        }
        return "no-email-field";
      }, cfg.email);
      addLog(`Email field check: ${emailOnPwdPage}`, "info");

      const pwdSelector = "input[type='password'], input[name='password'], #password-field";
      await page.waitForSelector(pwdSelector, { timeout: 5000 });

      // Clear password field and type
      await page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLInputElement | null;
        if (!el) return;
        el.focus();
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, pwdSelector);
      await page.click(pwdSelector);
      await page.keyboard.down("Control");
      await page.keyboard.press("a");
      await page.keyboard.up("Control");
      await page.type(pwdSelector, cfg.password, { delay: 60 });
      addLog("Typed password", "info");
      await new Promise((r) => setTimeout(r, 800));

      const clickedPwd = await page.evaluate(new Function(`return ${clickContinueScript()}`) as () => string | null);
      if (!clickedPwd) await page.keyboard.press("Enter");
      addLog(`Continue after password (method: ${clickedPwd ?? "Enter"})`, "info");

      // Wait for navigation/response
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});

    } else if (step === "otp") {
      state.currentStep = "otp";
      addLog("OTP step — waiting for email to arrive (5s)...", "info");

      await new Promise((r) => setTimeout(r, 5000));

      const otp = await fetchOtpFromImap();
      if (!otp) {
        addLog("Could not retrieve OTP from email", "error");
        return;
      }

      addLog(`OTP target input: checking Clerk selectors...`, "info");

      // Strategy A: single combined OTP input (Clerk sometimes uses one input)
      const pastedA = await page.evaluate((code: string) => {
        const sels = [
          "input[autocomplete='one-time-code']",
          "input[data-input-otp]",
          "[class*='otpCode'] input",
          "[class*='OtpCode'] input",
        ];
        for (const sel of sels) {
          const inputs = Array.from(document.querySelectorAll(sel)) as HTMLInputElement[];
          if (inputs.length === 1) {
            inputs[0].focus();
            inputs[0].value = code;
            inputs[0].dispatchEvent(new InputEvent("input", { bubbles: true, data: code }));
            inputs[0].dispatchEvent(new Event("change", { bubbles: true }));
            return `pasted:${sel}`;
          }
          // Multiple single-digit boxes
          if (inputs.length > 1 && inputs.length <= 8) {
            for (let i = 0; i < inputs.length && i < code.length; i++) {
              inputs[i].focus();
              inputs[i].value = code[i];
              inputs[i].dispatchEvent(new InputEvent("input", { bubbles: true, data: code[i] }));
            }
            return `pasted-multi:${sel}`;
          }
        }
        return null;
      }, otp);

      addLog(`OTP strategy A: ${pastedA ?? "no match"}`, "info");

      if (!pastedA) {
        // Strategy B: find first OTP box, focus it, type digit by digit
        addLog("OTP strategy B: keyboard type digit by digit...", "info");
        const otpSelectors = [
          "input[autocomplete='one-time-code']",
          "input[data-input-otp]",
          "[class*='otpCode'] input",
          "input[maxlength='1'][type='text']",
          "input[maxlength='6']",
        ];
        for (const sel of otpSelectors) {
          const found = await page.$(sel);
          if (found) {
            await found.click();
            await page.keyboard.type(otp, { delay: 100 });
            addLog(`OTP strategy B: typed into ${sel}`, "info");
            break;
          }
        }
      }

      await new Promise((r) => setTimeout(r, 1000));

      // Submit — skip social buttons here too
      const SOCIAL = ["google","github","apple","facebook","twitter","microsoft"];
      const otpSubmitted = await page.evaluate((social: string[]) => {
        const btns = Array.from(document.querySelectorAll<HTMLButtonElement>("button[type='submit'], button"));
        for (const btn of btns) {
          const t = (btn.textContent ?? "").toLowerCase().trim();
          if (social.some(s => t.includes(s))) continue;
          if (!btn.disabled && (t.includes("continue") || t.includes("verify") || t.includes("confirm") || btn.type === "submit")) {
            btn.click(); return t || "submit";
          }
        }
        return null;
      }, SOCIAL);
      if (!otpSubmitted) await page.keyboard.press("Enter");
      addLog(`OTP submitted (btn: ${otpSubmitted ?? "Enter"})`, "info");

      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
    }

    await new Promise((r) => setTimeout(r, 2000));

    const finalUrl = await page.evaluate(() => window.location.href).catch(() => "unknown");
    const finalStep = await detectLoginStep(page);
    addLog(`Post-action: step="${finalStep}" url=${finalUrl}`, "info");

    if (finalStep === "none") {
      state.currentStep = null;
      addLog("Auto-login completed successfully!", "success");
    }

    lastCompletedStep = step;
    lastCompletedStepAt = Date.now();

  } catch (err) {
    addLog(`Auto-login error: ${err instanceof Error ? err.message : String(err)}`, "error");
  } finally {
    state.active = false;
    autoLoginLock = false;
  }
}
