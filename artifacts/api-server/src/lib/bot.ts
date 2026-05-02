import puppeteer, { type Browser, type Page } from "puppeteer";
import fs, { existsSync } from "fs";
import path from "path";
import { logger } from "./logger";
import { runAutoLoginStep, loadConfig as loadAutoLoginConfig } from "./auto-login";

const NIX_CHROMIUM =
  "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium";

// Where we tell Render to install Chrome during build (inside the project dir so it
// gets uploaded as part of the build artifact and is available at runtime).
const RENDER_PUPPETEER_CACHE = "/opt/render/project/src/.puppeteer-cache";

/**
 * Scan a puppeteer cache directory for a Chrome binary.
 * Structure: {cacheDir}/chrome/linux-{version}/chrome-linux64/chrome
 */
function findChromeInDir(cacheDir: string): string | null {
  try {
    const chromeRoot = path.join(cacheDir, "chrome");
    const versionDirs = fs.readdirSync(chromeRoot);
    for (const vDir of versionDirs) {
      const bin = path.join(chromeRoot, vDir, "chrome-linux64", "chrome");
      if (existsSync(bin)) return bin;
    }
  } catch {}
  return null;
}

function getChromiumPath(): string {
  // 1. Replit / NixOS dev environment
  if (existsSync(NIX_CHROMIUM)) return NIX_CHROMIUM;

  // 2. Explicit override via env var
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;

  // 3. Render: Chrome installed to project-relative cache during build
  //    This works regardless of whether PUPPETEER_CACHE_DIR is set at runtime
  const renderBin = findChromeInDir(RENDER_PUPPETEER_CACHE);
  if (renderBin) return renderBin;

  // 4. Custom PUPPETEER_CACHE_DIR (any other environment)
  const customCache = process.env.PUPPETEER_CACHE_DIR;
  if (customCache) {
    const customBin = findChromeInDir(customCache);
    if (customBin) return customBin;
  }

  // 5. Puppeteer default cache (local dev fallback)
  return puppeteer.executablePath();
}

const EARN_URL = "https://dash.blazenode.online/earn";
const SCREENSHOT_INTERVAL_MS = 4_000;
const WATCHDOG_INTERVAL_MS = 3_000;

// Store session file next to the server process's working directory (not dist/)
const SESSION_FILE = path.resolve(process.cwd(), "session.json");

interface BotState {
  running: boolean;
  needsLogin: boolean;
  startedAt: number | null;
  lastActivity: string | null;
  sessionActive: boolean;
  earning: boolean;
  currentEarnings: number | null;
  latestScreenshot: string | null;
  lastVerification: string | null;
  verificationCount: number;
  autoRestart: boolean;
  crashCount: number;
}

const state: BotState = {
  running: false,
  needsLogin: false,
  startedAt: null,
  lastActivity: null,
  sessionActive: false,
  earning: false,
  currentEarnings: null,
  latestScreenshot: null,
  lastVerification: null,
  verificationCount: 0,
  autoRestart: true,
  crashCount: 0,
};

// ─── Earnings history ─────────────────────────────────────────────────────────

interface EarningsPoint {
  value: number;
  timestamp: number;
}

const earningsHistory: EarningsPoint[] = [];
const MAX_EARNINGS_HISTORY = 144; // ~24h at one sample per 10 min
let lastEarningsReadAt = 0;
const EARNINGS_READ_INTERVAL_MS = 60_000;

let browser: Browser | null = null;
let page: Page | null = null;
let screenshotTimer: ReturnType<typeof setInterval> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let intentionalStop = false;

// ─── Session persistence ──────────────────────────────────────────────────────

async function saveSession(): Promise<void> {
  if (!page) return;
  try {
    const cookies = await page.cookies();

    // Also capture localStorage for sites that store auth state there
    let localStorageData: Record<string, string> = {};
    try {
      localStorageData = await page.evaluate(() => {
        const data: Record<string, string> = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k) data[k] = localStorage.getItem(k) ?? "";
        }
        return data;
      });
    } catch {
      // localStorage may be unavailable on some pages
    }

    fs.writeFileSync(
      SESSION_FILE,
      JSON.stringify({ cookies, localStorage: localStorageData }, null, 2),
    );
    logger.info({ path: SESSION_FILE, cookieCount: cookies.length }, "Session saved");
  } catch (err) {
    logger.warn({ err }, "Failed to save session");
  }
}

async function loadSession(): Promise<boolean> {
  try {
    if (!fs.existsSync(SESSION_FILE)) {
      logger.info({ path: SESSION_FILE }, "No saved session found");
      return false;
    }
    const raw = fs.readFileSync(SESSION_FILE, "utf8");
    const data = JSON.parse(raw);

    // Support both old format (array of cookies) and new format ({ cookies, localStorage })
    const cookies = Array.isArray(data) ? data : data.cookies;
    const localStorageData: Record<string, string> = Array.isArray(data)
      ? {}
      : (data.localStorage ?? {});

    if (!page || !Array.isArray(cookies) || cookies.length === 0) return false;
    await page.setCookie(...cookies);

    // Restore localStorage after navigating to the target domain
    if (Object.keys(localStorageData).length > 0) {
      try {
        await page.evaluate((ls: Record<string, string>) => {
          for (const [k, v] of Object.entries(ls)) {
            localStorage.setItem(k, v);
          }
        }, localStorageData);
      } catch {
        // localStorage restore is best-effort
      }
    }

    logger.info(
      { cookieCount: cookies.length, localStorageKeys: Object.keys(localStorageData).length },
      "Session loaded from disk",
    );
    return true;
  } catch (err) {
    logger.warn({ err }, "Failed to load session");
    return false;
  }
}

// ─── Screenshot ───────────────────────────────────────────────────────────────

async function takeScreenshot(): Promise<void> {
  if (!page) return;
  try {
    const buf = await page.screenshot({ type: "jpeg", quality: 65, encoding: "base64" });
    state.latestScreenshot = buf as string;
    const url = page.url();
    const isOnLoginFlow =
      url.includes("accounts.google") ||
      url.includes("/sign-in") ||
      url.includes("/login") ||
      url.includes("clerk") ||
      url === "https://dash.blazenode.online/" ||
      url === "about:blank";
    state.needsLogin = isOnLoginFlow;
    state.sessionActive = url.includes("/earn");
  } catch (err) {
    logger.warn({ err }, "Screenshot failed");
  }
}

// ─── Watchdog: ONLY runs on earn page ────────────────────────────────────────

async function watchdog(): Promise<void> {
  if (!page) return;

  try {
    const currentUrl = page.url();

    // Only dismiss popups and manage earning when we're on the earn page.
    // Do NOT interfere with the Google/Clerk login flow.
    const onEarnPage = currentUrl.includes("/earn");

    if (!onEarnPage) {
      // Still take a screenshot so the viewport stays live
      await takeScreenshot();
      // If session cookies exist and we land on login, save session so far
      if (currentUrl !== "about:blank") await saveSession();

      // Trigger auto-login if credentials are configured and we're on a login page
      const isLoginPage =
        currentUrl.includes("/sign-in") ||
        currentUrl.includes("/login") ||
        currentUrl.includes("clerk") ||
        currentUrl === "https://dash.blazenode.online/" ||
        currentUrl.startsWith("https://dash.blazenode.online/#/factor");
      if (isLoginPage && loadAutoLoginConfig()) {
        await runAutoLoginStep(page);
        return;
      }

      // Logged in but landed somewhere other than /earn (e.g. /dashboard) — redirect
      const isBlazeDashboard =
        currentUrl.startsWith("https://dash.blazenode.online") &&
        !currentUrl.includes("/earn") &&
        !currentUrl.includes("about:blank");
      if (isBlazeDashboard) {
        logger.info({ currentUrl }, "Logged in but not on /earn — redirecting");
        await page.goto(EARN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      }
      return;
    }

    const result = await page.evaluate(() => {
      const actions: string[] = [];

      function clickFirst(selectors: string[]): boolean {
        for (const sel of selectors) {
          const els = Array.from(document.querySelectorAll(sel));
          for (const el of els) {
            const text = (el.textContent ?? "").toLowerCase().trim();
            if (
              text.includes("i'm here") ||
              text.includes("im here") ||
              text.includes("i am here") ||
              text.includes("still here") ||
              text.includes("click to confirm") ||
              sel === "[data-verify]" ||
              sel === "[data-confirm]"
            ) {
              (el as HTMLElement).click();
              return true;
            }
          }
        }
        return false;
      }

      // 1. Look for verification / "are you here?" popup buttons (strict keywords only)
      const verifyClicked = clickFirst([
        "button",
        "a",
        "[role='button']",
        "[data-verify]",
        "[data-confirm]",
        ".btn",
        ".button",
      ]);
      if (verifyClicked) actions.push("verify_clicked");

      // 2. Look for modal/dialog confirm buttons as a fallback
      if (!verifyClicked) {
        const dialogs = document.querySelectorAll(
          "[role='dialog'], [role='alertdialog'], .modal, .dialog, .popup, .overlay",
        );
        for (const dialog of Array.from(dialogs)) {
          const btns = dialog.querySelectorAll("button, a, [role='button']");
          for (const btn of Array.from(btns)) {
            const t = (btn.textContent ?? "").toLowerCase().trim();
            if (t.length > 0 && t.length < 30) {
              (btn as HTMLElement).click();
              actions.push("dialog_btn_clicked:" + t);
              break;
            }
          }
        }
      }

      // 3. Click "Start AFK Earning" if earning is not active
      const allButtons = Array.from(
        document.querySelectorAll("button, a, [role='button']"),
      );
      for (const btn of allButtons) {
        const t = (btn.textContent ?? "").toLowerCase().trim();
        if (t.includes("start afk") || t.includes("start earning")) {
          (btn as HTMLElement).click();
          actions.push("start_earning_clicked");
          break;
        }
      }

      // 4. Detect if earning is currently running
      const pageText = document.body.innerText.toLowerCase();
      const isRunning =
        pageText.includes("stop afk") ||
        pageText.includes("earning active") ||
        pageText.includes("earning...") ||
        document.querySelector("[data-earning='true']") !== null ||
        document.querySelector(".earning-active") !== null;

      return { actions, isRunning };
    });

    if (
      result.actions.includes("verify_clicked") ||
      result.actions.some((a) => a.startsWith("dialog_btn_clicked"))
    ) {
      state.verificationCount += 1;
      state.lastVerification = new Date().toISOString();
      state.lastActivity = state.lastVerification;
      logger.info(
        { actions: result.actions, total: state.verificationCount },
        "Verification popup auto-dismissed",
      );
    }

    if (result.actions.includes("start_earning_clicked")) {
      state.lastActivity = new Date().toISOString();
      logger.info("Clicked Start AFK Earning");
    }

    state.earning = result.isRunning;

    // Read earnings once per minute while on earn page
    const now = Date.now();
    if (now - lastEarningsReadAt >= EARNINGS_READ_INTERVAL_MS) {
      lastEarningsReadAt = now;
      const earned = await readEarnings();
      if (earned !== null) {
        state.currentEarnings = earned;
        earningsHistory.push({ value: earned, timestamp: now });
        if (earningsHistory.length > MAX_EARNINGS_HISTORY) earningsHistory.shift();
      }
    }

    // Save session after any action (keeps cookies fresh)
    if (result.actions.length > 0) {
      await saveSession();
    }
  } catch (err) {
    logger.warn({ err }, "Watchdog tick failed");
  }
}

// ─── Start / Stop ─────────────────────────────────────────────────────────────

// ─── Auto-restart on crash ────────────────────────────────────────────────────

async function handleBrowserDisconnect(): Promise<void> {
  if (intentionalStop) return;
  if (!state.autoRestart) {
    logger.warn("Browser disconnected unexpectedly — auto-restart is OFF");
    await cleanupBrowser();
    return;
  }
  state.crashCount++;
  logger.warn({ crashCount: state.crashCount }, "Browser crashed — auto-restarting in 3s...");
  await cleanupBrowser();
  setTimeout(async () => {
    if (!state.autoRestart) return;
    logger.info("Auto-restarting bot after crash");
    await startBot();
  }, 3000);
}

export function setAutoRestart(enabled: boolean): void {
  state.autoRestart = enabled;
  logger.info({ autoRestart: enabled }, "Auto-restart setting changed");
}

export async function startBot(): Promise<{ success: boolean; message: string }> {
  if (state.running) {
    return { success: false, message: "Bot is already running" };
  }

  try {
    logger.info("Starting AFK bot");

    browser = await puppeteer.launch({
      headless: true,
      executablePath: getChromiumPath(),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--window-size=1024,640",
        // Memory savings for constrained environments (512 MB RAM)
        "--js-flags=--max-old-space-size=256",
        "--disable-extensions",
        "--disable-plugins",
        "--disable-images",
        "--blink-settings=imagesEnabled=false",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-translate",
        "--hide-scrollbars",
        "--mute-audio",
        "--disable-logging",
        // Hide automation signals so Google OAuth doesn't block the flow
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
      defaultViewport: { width: 1024, height: 640 },
    });

    browser.on("disconnected", handleBrowserDisconnect);

    page = await browser.newPage();

    // Match Chrome 138 (the actual binary version) so UA sniffing passes
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    );

    // Remove the webdriver property that headless Chrome exposes
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      // Spoof plugins so the browser looks real
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    });

    // Try to restore saved session so user doesn't need to re-login
    const sessionRestored = await loadSession();

    logger.info({ url: EARN_URL }, "Navigating to earn page");
    await page.goto(EARN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // If session was restored and we're now on the earn page, restore localStorage too
    if (sessionRestored) {
      await loadSession();
    }

    state.running = true;
    state.startedAt = Date.now();
    state.lastActivity = new Date().toISOString();
    state.verificationCount = 0;

    await takeScreenshot();

    screenshotTimer = setInterval(takeScreenshot, SCREENSHOT_INTERVAL_MS);
    watchdogTimer = setInterval(watchdog, WATCHDOG_INTERVAL_MS);

    logger.info({ sessionRestored }, "Bot started successfully");
    const msg = sessionRestored
      ? "Bot started. Session restored — earning should begin shortly."
      : "Bot started. Log in with Google in the viewport, then earning will begin automatically.";
    return { success: true, message: msg };
  } catch (err) {
    logger.error({ err }, "Failed to start bot");
    await cleanupBrowser();
    return {
      success: false,
      message: `Failed to start: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function cleanupBrowser(): Promise<void> {
  if (screenshotTimer) {
    clearInterval(screenshotTimer);
    screenshotTimer = null;
  }
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  if (browser) {
    try {
      await browser.close();
    } catch {}
    browser = null;
  }
  page = null;
  state.running = false;
  state.startedAt = null;
  state.sessionActive = false;
  state.needsLogin = false;
  state.earning = false;
  state.latestScreenshot = null;
}

export async function stopBot(): Promise<{ success: boolean; message: string }> {
  if (!state.running) {
    return { success: false, message: "Bot is not running" };
  }
  intentionalStop = true;
  await saveSession();
  await cleanupBrowser();
  intentionalStop = false;
  logger.info("Bot stopped");
  return { success: true, message: "Bot stopped" };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | void> {
  return Promise.race([promise, new Promise<void>((r) => setTimeout(r, ms))]);
}

// ─── Earnings scraping ────────────────────────────────────────────────────────

async function readEarnings(): Promise<number | null> {
  if (!page) return null;
  try {
    const value = await withTimeout(
      page.evaluate(() => {
        const body = document.body.innerText ?? "";
        const lines = body.split("\n").map((l) => l.trim());

        // Strategy 1: scan line-by-line for "EARNED" label, grab adjacent number
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].toLowerCase();
          const isEarnedLabel =
            line === "earned" || line === "coins earned" || line === "total earned";
          if (!isEarnedLabel) continue;

          const prev = lines[i - 1] ?? "";
          const prevNum = parseFloat(prev.replace(/[^0-9.]/g, ""));
          if (!isNaN(prevNum) && prev.replace(/[^0-9.]/g, "").length > 0) return prevNum;

          const next = lines[i + 1] ?? "";
          if (!next.toLowerCase().includes("per")) {
            const nextNum = parseFloat(next.replace(/[^0-9.]/g, ""));
            if (!isNaN(nextNum) && next.replace(/[^0-9.]/g, "").length > 0) return nextNum;
          }
        }

        // Strategy 2: DOM — find element with text "earned", grab sibling number
        const allEls = Array.from(document.querySelectorAll("*"));
        for (const el of allEls) {
          const text = (el.textContent ?? "").trim().toLowerCase();
          if (
            text !== "earned" &&
            text !== "coins earned" &&
            text !== "total earned"
          )
            continue;
          const parent = el.parentElement;
          if (parent) {
            for (const sib of Array.from(parent.children)) {
              if (sib === el) continue;
              const raw = (sib.textContent ?? "").trim().replace(/[^0-9.]/g, "");
              const num = parseFloat(raw);
              if (!isNaN(num) && raw.length > 0) return num;
            }
            const gp = parent.parentElement;
            if (gp) {
              for (const child of Array.from(gp.children)) {
                if (child === parent) continue;
                const raw = (child.textContent ?? "").trim().replace(/[^0-9.]/g, "");
                const num = parseFloat(raw);
                if (!isNaN(num) && raw.length > 0) return num;
              }
            }
          }
        }

        // Strategy 3: regex — number on same line as "earned" (not "per")
        const m =
          body.match(/\b([0-9,]+\.?[0-9]*)\s+earned\b(?!\s*per|\s*\/)/i) ??
          body.match(/\bearned\s*:?\s*([0-9,]+\.?[0-9]*)\b(?!\s*per|\s*\/)/i);
        if (m) return parseFloat(m[1].replace(/,/g, ""));

        return null;
      }),
      4000,
    );
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

export async function forceReadEarnings(): Promise<{ value: number | null; pageLines: string[] }> {
  if (!page) return { value: null, pageLines: ["Bot page not available"] };
  let pageLines: string[] = [];
  try {
    const lines = await withTimeout(
      page.evaluate(() =>
        (document.body.innerText ?? "")
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      ),
      4000,
    );
    if (Array.isArray(lines)) pageLines = lines as string[];
  } catch {
    /* ignore */
  }
  lastEarningsReadAt = 0; // reset so watchdog picks it up immediately
  const value = await readEarnings();
  if (value !== null) {
    state.currentEarnings = value;
    earningsHistory.push({ value, timestamp: Date.now() });
    if (earningsHistory.length > MAX_EARNINGS_HISTORY) earningsHistory.shift();
  }
  return { value, pageLines };
}

export function getEarningsData() {
  return {
    current: state.currentEarnings,
    history: earningsHistory,
  };
}

async function applyAntiDetection(p: Page): Promise<void> {
  await p.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  );
  await p.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });
}

export async function clickAt(
  x: number,
  y: number,
): Promise<{ success: boolean; message: string }> {
  if (!page || !browser) {
    return { success: false, message: "Bot is not running" };
  }
  try {
    const urlBefore = page.url();

    // Listen for a new popup/tab BEFORE clicking (e.g. Clerk opens Google OAuth via window.open)
    const popupPromise = new Promise<Page | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 4000);
      browser!.once("targetcreated", async (target) => {
        clearTimeout(timer);
        try {
          const p = await target.page();
          resolve(p ?? null);
        } catch {
          resolve(null);
        }
      });
    });

    await page.mouse.click(x, y);

    // Wait for either a new popup OR a same-tab navigation to start
    const popupPage = await popupPromise;

    if (popupPage) {
      // A new window/popup opened (e.g. Google OAuth popup)
      logger.info("New popup detected after click — applying anti-detection and switching");
      await applyAntiDetection(popupPage);
      page = popupPage;
      // Wait for the popup to reach a stable state
      await withTimeout(
        popupPage.waitForNavigation({ waitUntil: "domcontentloaded" }),
        5000,
      );
      logger.info({ url: page.url() }, "Popup loaded");
    } else {
      // No popup — check if the current page navigated (same-tab redirect)
      await new Promise((r) => setTimeout(r, 1000));
      const urlAfter = page.url();
      if (urlAfter !== urlBefore) {
        logger.info({ from: urlBefore, to: urlAfter }, "Same-tab navigation detected after click");
        // Wait for the new page to settle
        await withTimeout(
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          5000,
        );
      }
    }

    // Take screenshot with a timeout so we never hang
    await withTimeout(takeScreenshot(), 6000);
    // Save session with timeout
    await withTimeout(saveSession(), 5000);

    return { success: true, message: `Clicked at (${x}, ${y})` };
  } catch (err) {
    return {
      success: false,
      message: `Click failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function typeText(
  text: string,
): Promise<{ success: boolean; message: string }> {
  if (!page) {
    return { success: false, message: "Bot is not running" };
  }
  try {
    await page.keyboard.type(text, { delay: 50 });
    await new Promise((r) => setTimeout(r, 500));
    await takeScreenshot();
    return { success: true, message: `Typed ${text.length} character(s)` };
  } catch (err) {
    return {
      success: false,
      message: `Type failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function pressKey(
  key: string,
): Promise<{ success: boolean; message: string }> {
  if (!page) {
    return { success: false, message: "Bot is not running" };
  }
  try {
    await page.keyboard.press(key as Parameters<typeof page.keyboard.press>[0]);
    await new Promise((r) => setTimeout(r, 500));
    await takeScreenshot();
    // Save session on Enter — might have submitted a login form
    if (key === "Enter") await saveSession();
    return { success: true, message: `Pressed ${key}` };
  } catch (err) {
    return {
      success: false,
      message: `Key press failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function getBotStatus() {
  return {
    running: state.running,
    needsLogin: state.needsLogin,
    uptime: state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : null,
    screenshot: state.latestScreenshot,
    lastActivity: state.lastActivity,
    sessionActive: state.sessionActive,
    earning: state.earning,
    coinsEarned: state.currentEarnings,
    lastVerification: state.lastVerification,
    verificationCount: state.verificationCount,
    autoRestart: state.autoRestart,
    crashCount: state.crashCount,
  };
}

export function getLatestScreenshot() {
  return {
    screenshot: state.latestScreenshot,
    timestamp: new Date().toISOString(),
  };
}
