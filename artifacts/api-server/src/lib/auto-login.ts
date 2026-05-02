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
      // Search ALL emails in the last 15 minutes (seen or unseen) from BLAZENODE
      const since = new Date(Date.now() - 15 * 60 * 1000);
      const allRecent = await client.search({ since });

      if (!allRecent || allRecent.length === 0) {
        addLog("No recent emails found in last 15 min", "warning");
        return null;
      }

      addLog(`Found ${allRecent.length} recent email(s) — checking newest first`, "info");

      // Fetch all recent messages, newest UIDs last → iterate in reverse for newest first
      const uidsToCheck = [...allRecent].reverse().slice(0, 10);

      for (const uid of uidsToCheck) {
        // Fetch envelope (subject + from) — much faster than full source
        const msg = await client.fetchOne(String(uid), { envelope: true, source: true });
        if (!msg) continue;

        const from = (msg.envelope?.from?.[0]?.name ?? "") + " " +
                     (msg.envelope?.from?.[0]?.address ?? "");
        const subject = msg.envelope?.subject ?? "";
        const raw = msg.source?.toString() ?? "";

        // Only process BLAZENODE emails
        const isBlazeMail =
          from.toLowerCase().includes("blazenode") ||
          subject.toLowerCase().includes("blazenode") ||
          subject.toLowerCase().includes("verification") ||
          raw.toLowerCase().includes("blazenode");

        if (!isBlazeMail) continue;

        addLog(`Checking email: "${subject}" from "${from.trim()}"`, "info");

        // Subject often contains the code directly: "222084 is your verification code"
        const subjectMatch = subject.match(/\b(\d{6})\b/);
        if (subjectMatch) {
          addLog(`OTP from subject: ${subjectMatch[1]}`, "success");
          await client.logout();
          return subjectMatch[1];
        }

        // Fall back to full body
        const bodyMatch = raw.match(/\b(\d{6})\b/);
        if (bodyMatch) {
          addLog(`OTP from body: ${bodyMatch[1]}`, "success");
          await client.logout();
          return bodyMatch[1];
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();
    addLog("No OTP code found in recent BLAZENODE emails", "warning");
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
      // React-controlled inputs IGNORE direct .value assignments — we must use
      // real Puppeteer keyboard events so React state gets updated.
      const emailSelectors = [
        "input[name='identifier']",
        "input[type='email']",
        "#identifier-field",
      ];

      let emailFilled = false;
      for (const sel of emailSelectors) {
        const el = await page.$(sel);
        if (!el) continue;

        // Check current value — if already correct, skip typing
        const currentVal = await page.evaluate(
          (s) => (document.querySelector(s) as HTMLInputElement | null)?.value ?? "",
          sel,
        );

        if (currentVal.trim() === cfg.email) {
          addLog(`Email already correct in field (${sel})`, "info");
          emailFilled = true;
          break;
        }

        // Click → select all → delete → type using real keystrokes
        addLog(`Filling email via keyboard into ${sel}`, "info");
        await page.click(sel);
        await new Promise((r) => setTimeout(r, 200));
        await page.keyboard.down("Control");
        await page.keyboard.press("a");
        await page.keyboard.up("Control");
        await page.keyboard.press("Backspace");
        await new Promise((r) => setTimeout(r, 150));
        await page.type(sel, cfg.email, { delay: 60 });
        addLog(`Typed email into ${sel}: ${cfg.email}`, "info");
        emailFilled = true;
        await new Promise((r) => setTimeout(r, 400));
        break;
      }

      if (!emailFilled) {
        addLog("No email field found on password page — proceeding anyway", "warning");
      }

      const pwdSelector = "input[type='password'], input[name='password'], #password-field";
      await page.waitForSelector(pwdSelector, { timeout: 5000 });

      // Click → select all → delete → type password via real keystrokes
      await page.click(pwdSelector);
      await new Promise((r) => setTimeout(r, 200));
      await page.keyboard.down("Control");
      await page.keyboard.press("a");
      await page.keyboard.up("Control");
      await page.keyboard.press("Backspace");
      await new Promise((r) => setTimeout(r, 150));
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

      addLog(`OTP target input: finding Clerk digit boxes...`, "info");

      // Clerk renders 6 individual digit boxes. We must use real Puppeteer
      // keyboard events — React ignores direct .value assignments entirely.
      // Priority: find all 6 boxes → click first → type all digits.
      const otpSelectorCandidates = [
        "input[maxlength='1']",                    // Clerk individual digit boxes
        "[data-input-otp-slot] input",
        ".cl-otpCodeFieldInput",
        "input[autocomplete='one-time-code']",      // may be 1 or 6 elements
        "input[data-input-otp]",
        "[class*='otpCode'] input",
        "[class*='OtpCode'] input",
        "input[maxlength='6']",
      ];

      let otpHandled = false;
      for (const sel of otpSelectorCandidates) {
        const inputs = await page.$$(sel);
        if (inputs.length === 0) continue;

        addLog(`OTP: found ${inputs.length} input(s) via "${sel}" — typing via keyboard`, "info");

        // Click the first box to focus it, then type all digits.
        // Clerk moves focus to the next box automatically after each digit.
        await inputs[0].click();
        await new Promise((r) => setTimeout(r, 200));
        await page.keyboard.type(otp, { delay: 120 });
        addLog(`OTP typed (${inputs.length} box(es), sel: ${sel})`, "info");
        otpHandled = true;
        break;
      }

      if (!otpHandled) {
        // Last resort: no selector matched — dump keys into whatever is focused
        addLog("OTP fallback: no input found, typing into focused element", "warning");
        await page.keyboard.type(otp, { delay: 120 });
      }

      // Wait 2s — Clerk auto-submits when all 6 digits are detected
      await new Promise((r) => setTimeout(r, 2000));

      // Check if Clerk already navigated away (auto-submit worked)
      const urlAfterOtp = await page.evaluate(() => window.location.href).catch(() => "");
      const stillOnOtp = urlAfterOtp.includes("factor") || urlAfterOtp.includes("otp");

      if (stillOnOtp) {
        addLog("Clerk did not auto-submit — clicking Continue button manually", "info");

        // Words that mean "skip / go back / resend" — must NOT click these
        const SKIP_WORDS = [
          "resend", "didn't receive", "didnt receive", "send again",
          "back", "cancel", "change", "use another", "try another",
          "google", "github", "apple", "facebook", "twitter", "microsoft",
        ];

        const otpSubmitted = await page.evaluate((skipWords: string[]) => {
          const btns = Array.from(
            document.querySelectorAll<HTMLButtonElement>("button[type='submit'], button"),
          );
          for (const btn of btns) {
            const t = (btn.textContent ?? "").toLowerCase().trim();
            // Skip any button whose text contains a skip-word
            if (skipWords.some((w) => t.includes(w))) continue;
            if (btn.disabled) continue;
            // Click if it looks like a primary action button
            if (
              t.includes("continue") ||
              t.includes("verify") ||
              t.includes("confirm") ||
              t.includes("submit") ||
              btn.type === "submit"
            ) {
              btn.click();
              return t || "submit-btn";
            }
          }
          return null;
        }, SKIP_WORDS);

        if (!otpSubmitted) await page.keyboard.press("Enter");
        addLog(`OTP submitted (btn: ${otpSubmitted ?? "Enter"})`, "info");
      } else {
        addLog("Clerk auto-submitted OTP successfully", "success");
      }

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
