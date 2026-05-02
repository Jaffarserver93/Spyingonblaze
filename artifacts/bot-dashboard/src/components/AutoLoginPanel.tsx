import { useState, useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, Mail, Eye, EyeOff, FlaskConical, Save, Bot } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { motion, AnimatePresence } from "framer-motion";

interface AutoLoginLog {
  time: string;
  message: string;
  type: "info" | "success" | "warning" | "error";
}

interface AutoLoginState {
  configured: boolean;
  active: boolean;
  currentStep: string | null;
  log: AutoLoginLog[];
  lastAttempt: string | null;
  email: string | null;
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPasswordSaved: boolean;
}

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

export default function AutoLoginPanel() {
  const [expanded, setExpanded] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [showImapPassword, setShowImapPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [serverState, setServerState] = useState<AutoLoginState | null>(null);

  const [email, setEmail] = useState("jaffarkingsas@gmail.com");
  const [password, setPassword] = useState("jxfrJxfr12!A");
  const [imapHost, setImapHost] = useState("imap.gmail.com");
  const [imapPort, setImapPort] = useState("993");
  const [imapUser, setImapUser] = useState("");
  const [imapPassword, setImapPassword] = useState("");

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetchState();
    pollRef.current = setInterval(fetchState, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  async function fetchState() {
    try {
      const r = await fetch(`${BASE}/api/auto-login/config`);
      if (r.ok) {
        const data: AutoLoginState = await r.json();
        setServerState(data);
        if (data.email) setEmail(data.email);
        if (data.imapHost) setImapHost(data.imapHost);
        if (data.imapPort) setImapPort(String(data.imapPort));
        if (data.imapUser) setImapUser(data.imapUser);
        // Only pre-fill imap password placeholder if saved and user hasn't typed anything
        if (data.imapPasswordSaved && imapPassword === "") {
          setImapPassword("__SAVED__");
        }
      }
    } catch {}
  }

  async function handleSave() {
    if (!email || !password || !imapHost || !imapPort || !imapPassword) return;
    setSaving(true);
    // "__SAVED__" sentinel means keep the existing password on the server — send empty string to signal "don't overwrite"
    const imapPasswordToSend = imapPassword === "__SAVED__" ? "" : imapPassword;
    try {
      const r = await fetch(`${BASE}/api/auto-login/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, imapHost, imapPort: Number(imapPort), imapUser, imapPassword: imapPasswordToSend }),
      });
      const data = await r.json();
      if (data.success) {
        await fetchState();
        setTestResult({ success: true, message: "Credentials saved successfully" });
        setTimeout(() => setTestResult(null), 3000);
      }
    } catch {
      setTestResult({ success: false, message: "Failed to save credentials" });
    } finally {
      setSaving(false);
    }
  }

  async function handleTestImap() {
    if (!imapHost || !imapPort || !imapPassword) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await fetch(`${BASE}/api/auto-login/test-imap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imapHost, imapPort: Number(imapPort), imapUser, imapPassword, email }),
      });
      const data = await r.json();
      setTestResult(data);
      setTimeout(() => setTestResult(null), 5000);
    } catch {
      setTestResult({ success: false, message: "Request failed" });
    } finally {
      setTesting(false);
    }
  }

  const configured = serverState?.configured ?? false;
  const active = serverState?.active ?? false;

  const statusLabel = active ? "ACTIVE" : configured ? "CONFIGURED" : "NOT CONFIGURED";
  const statusClass = active
    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
    : configured
    ? "bg-blue-500/10 text-blue-400 border-blue-500/30"
    : "bg-amber-500/10 text-amber-400 border-amber-500/30";

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/20 transition-colors"
      >
        <div className="flex items-center gap-2 text-sm font-bold tracking-widest uppercase">
          <Bot className="w-4 h-4 text-primary" />
          Auto_Login
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border ${statusClass}`}>
            {statusLabel}
          </span>
          {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </div>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="p-4 pt-0 space-y-4 border-t border-border">

              {/* Two-column credential grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3">

                {/* BlazeNode Account */}
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                    <Mail className="w-3 h-3" />
                    BlazeNode Account
                  </div>
                  <Input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Email (your BlazeNode login)"
                    className="font-mono text-sm bg-background/50 border-border/60"
                    type="email"
                  />
                  <div className="relative">
                    <Input
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Password"
                      type={showPassword ? "text" : "password"}
                      className="font-mono text-sm bg-background/50 border-border/60 pr-10"
                    />
                    <button
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      tabIndex={-1}
                      type="button"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* IMAP Config */}
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                    <Mail className="w-3 h-3" />
                    IMAP (for OTP emails)
                  </div>
                  <div className="flex gap-2">
                    <Input
                      value={imapHost}
                      onChange={(e) => setImapHost(e.target.value)}
                      placeholder="imap.gmail.com"
                      className="font-mono text-sm bg-background/50 border-border/60 flex-1"
                    />
                    <Input
                      value={imapPort}
                      onChange={(e) => setImapPort(e.target.value)}
                      placeholder="993"
                      className="font-mono text-sm bg-background/50 border-border/60 w-20"
                      type="number"
                    />
                  </div>
                  <Input
                    value={imapUser}
                    onChange={(e) => setImapUser(e.target.value)}
                    placeholder="IMAP user (leave blank = same as email)"
                    className="font-mono text-sm bg-background/50 border-border/60"
                  />
                  <div className="relative">
                    <Input
                      value={imapPassword === "__SAVED__" ? "" : imapPassword}
                      onChange={(e) => setImapPassword(e.target.value)}
                      placeholder={imapPassword === "__SAVED__" ? "●●●●●●●●●●●●●●●● (saved)" : "IMAP App Password (Gmail: myaccount.google.com)"}
                      type={showImapPassword ? "text" : "password"}
                      className={`font-mono text-sm bg-background/50 border-border/60 pr-10 ${imapPassword === "__SAVED__" ? "placeholder:text-emerald-500/60" : ""}`}
                    />
                    <button
                      onClick={() => setShowImapPassword((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      tabIndex={-1}
                      type="button"
                    >
                      {showImapPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>

              {/* Action buttons */}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  size="sm"
                  className="font-mono text-xs tracking-widest rounded-sm"
                  onClick={handleSave}
                  disabled={saving || !email || !password || !imapHost || !imapPort || !imapPassword}
                >
                  <Save className="w-3.5 h-3.5 mr-1.5" />
                  {saving ? "SAVING..." : "SAVE_CREDENTIALS"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="font-mono text-xs tracking-widest rounded-sm"
                  onClick={handleTestImap}
                  disabled={testing || !imapHost || !imapPort || !imapPassword}
                >
                  <FlaskConical className="w-3.5 h-3.5 mr-1.5" />
                  {testing ? "TESTING..." : "TEST_IMAP"}
                </Button>
                {testResult && (
                  <motion.span
                    initial={{ opacity: 0, x: -5 }}
                    animate={{ opacity: 1, x: 0 }}
                    className={`text-xs font-mono ${testResult.success ? "text-emerald-400" : "text-destructive"}`}
                  >
                    {testResult.success ? "✓" : "✗"} {testResult.message}
                  </motion.span>
                )}
              </div>

              {/* Helper text */}
              <div className="text-[11px] text-muted-foreground space-y-1 leading-relaxed border-t border-border/50 pt-3">
                <p>
                  <span className="text-amber-400 font-bold">Gmail users:</span>{" "}
                  Go to myaccount.google.com → Security → 2-Step Verification → App passwords → generate one for "Mail". Use that as IMAP App Password.
                </p>
                <p>
                  <span className="text-primary font-bold">Auto-login fires</span>{" "}
                  automatically when bot detects the Clerk login page on startup or after a crash. OTP is read from your inbox via IMAP — no manual steps needed.
                </p>
              </div>

              {/* Auto-login log */}
              {(serverState?.log?.length ?? 0) > 0 && (
                <div className="border-t border-border/50 pt-3 space-y-2">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                    Auto-Login Log
                  </div>
                  <ScrollArea className="h-32 rounded border border-border/40 bg-black/20">
                    <div className="p-3 space-y-1 font-mono text-[11px]">
                      {(serverState?.log ?? []).map((entry, i) => (
                        <div key={i} className="flex gap-2 items-start">
                          <span className="text-muted-foreground opacity-60 shrink-0">{entry.time}</span>
                          <span className={
                            entry.type === "error" ? "text-destructive" :
                            entry.type === "success" ? "text-emerald-400" :
                            entry.type === "warning" ? "text-amber-400" :
                            "text-foreground/80"
                          }>{entry.message}</span>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              )}

            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
