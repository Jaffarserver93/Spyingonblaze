import { useEffect, useRef, useState, KeyboardEvent } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  useGetBotStatus,
  useGetBotScreenshot,
  useStartBot,
  useStopBot,
  useBotClick,
  useBotType,
  getGetBotStatusQueryKey,
  getGetBotScreenshotQueryKey,
} from "@workspace/api-client-react";
import {
  Play, Square, Terminal, AlertTriangle, Clock, Activity,
  Loader2, ShieldCheck, Coins, Keyboard, Send, CornerDownLeft, RefreshCw, TrendingUp,
} from "lucide-react";
import AutoLoginPanel from "@/components/AutoLoginPanel";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { motion, AnimatePresence } from "framer-motion";
import { useToast } from "@/hooks/use-toast";

interface LogEntry {
  id: string;
  time: Date;
  message: string;
  type: "info" | "success" | "warning" | "error";
}

function formatUptime(seconds: number | null): string {
  if (seconds === null) return "00:00:00";
  const h = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

export default function Home() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [logs, setLogs] = useState<LogEntry[]>([{
    id: "init",
    time: new Date(),
    message: "Dashboard initialized. Waiting for connection...",
    type: "info",
  }]);
  const [isClicking, setIsClicking] = useState(false);
  const [typeInput, setTypeInput] = useState("");
  const [displayUptime, setDisplayUptime] = useState<number | null>(null);
  // Two-layer crossfade for viewport screenshots
  const [baseSrc, setBaseSrc] = useState<string | null>(null);
  const [fadeSrc, setFadeSrc] = useState<string | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const typeInputRef = useRef<HTMLInputElement>(null);

  // ─── API Hooks ────────────────────────────────────────────────────────────

  const { data: status } = useGetBotStatus({
    query: { refetchInterval: 3000, queryKey: getGetBotStatusQueryKey() },
  });

  const { data: screenshotData, refetch: refetchScreenshot } = useGetBotScreenshot({
    query: { refetchInterval: 2000, queryKey: getGetBotScreenshotQueryKey() },
  });

  const startBot = useStartBot({
    mutation: {
      onSuccess: (data) => {
        addLog(data.success ? data.message : `Failed to start: ${data.message}`, data.success ? "success" : "error");
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetBotScreenshotQueryKey() });
      },
      onError: (error) => addLog(`Error starting bot: ${error}`, "error"),
    },
  });

  const stopBot = useStopBot({
    mutation: {
      onSuccess: (data) => {
        addLog(data.success ? "Bot stopped successfully" : `Failed to stop: ${data.message}`, data.success ? "info" : "error");
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetBotScreenshotQueryKey() });
      },
      onError: (error) => addLog(`Error stopping bot: ${error}`, "error"),
    },
  });

  const [isRestarting, setIsRestarting] = useState(false);
  const restartBot = async () => {
    if (isRestarting) return;
    setIsRestarting(true);
    addLog("Restarting bot...", "warning");
    try {
      const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
      const res = await fetch(`${BASE}/api/bot/restart`, { method: "POST" });
      const data = await res.json();
      addLog(data.success ? "Bot restarted successfully" : `Restart failed: ${data.message}`, data.success ? "success" : "error");
    } catch (e) {
      addLog(`Restart error: ${e}`, "error");
    } finally {
      setIsRestarting(false);
      queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetBotScreenshotQueryKey() });
    }
  };

  const botClick = useBotClick({
    mutation: {
      onSuccess: (data) => {
        addLog(data.success ? "Click forwarded to browser" : `Click failed: ${data.message}`, data.success ? "success" : "error");
        setIsClicking(false);
        setTimeout(() => refetchScreenshot(), 600);
        // Focus typing bar after a click so keyboard is ready
        setTimeout(() => typeInputRef.current?.focus(), 700);
      },
      onError: (error) => {
        addLog(`Error forwarding click: ${error}`, "error");
        setIsClicking(false);
      },
    },
  });

  const botType = useBotType({
    mutation: {
      onSuccess: (data) => {
        addLog(data.success ? `Typed: "${typeInput}"` : `Type failed: ${data.message}`, data.success ? "success" : "error");
        if (data.success) setTypeInput("");
        setTimeout(() => refetchScreenshot(), 600);
      },
      onError: (error) => addLog(`Type error: ${error}`, "error"),
    },
  });

  const addLog = (message: string, type: LogEntry["type"] = "info") => {
    setLogs((prev) => [{
      id: Math.random().toString(36).substring(7),
      time: new Date(),
      message,
      type,
    }, ...prev].slice(0, 50));
  };

  // ─── Screenshot crossfade ─────────────────────────────────────────────────

  useEffect(() => {
    const newSrc = screenshotData?.screenshot ?? null;
    if (!newSrc || newSrc === baseSrc) return;

    if (!baseSrc) {
      // First screenshot ever — show instantly, no fade needed
      setBaseSrc(newSrc);
      return;
    }

    // Swap in the new screenshot as the fade-in layer
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    setFadeSrc(newSrc);

    // After the CSS transition completes, promote it to the base layer
    fadeTimerRef.current = setTimeout(() => {
      setBaseSrc(newSrc);
      setFadeSrc(null);
    }, 420);
  }, [screenshotData?.screenshot]);

  useEffect(() => () => {
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
  }, []);

  // ─── Smooth uptime counter ────────────────────────────────────────────────

  useEffect(() => {
    if (status?.uptime == null || !status.running) {
      setDisplayUptime(status?.running ? (status.uptime ?? null) : null);
      return;
    }
    setDisplayUptime(status.uptime);
    const timer = setInterval(() => {
      setDisplayUptime((prev) => (prev !== null ? prev + 1 : null));
    }, 1000);
    return () => clearInterval(timer);
  }, [status?.uptime, status?.running]);

  // ─── Status watchers ─────────────────────────────────────────────────────

  const prevRunning = useRef<boolean | null>(null);
  const prevNeedsLogin = useRef<boolean | null>(null);
  const prevEarning = useRef<boolean | null>(null);
  const prevVerificationCount = useRef<number | null>(null);

  useEffect(() => {
    if (!status) return;

    if (prevRunning.current !== null && prevRunning.current !== status.running) {
      addLog(`Bot is now ${status.running ? "RUNNING" : "STOPPED"}`, status.running ? "success" : "warning");
    }

    if (prevNeedsLogin.current !== null && prevNeedsLogin.current !== status.needsLogin) {
      if (status.needsLogin) {
        addLog("Authentication required. Click in the viewport to interact.", "warning");
        toast({ title: "Login Required", description: "Click the Google login button in the viewport, then use the keyboard bar below to type your email.", variant: "destructive" });
      } else if (!status.needsLogin && prevNeedsLogin.current) {
        addLog("Authentication successful. Session active.", "success");
      }
    }

    if (prevEarning.current !== null && prevEarning.current !== status.earning) {
      addLog(status.earning ? "AFK earning is now ACTIVE" : "AFK earning stopped", status.earning ? "success" : "warning");
    }

    if (prevVerificationCount.current !== null && status.verificationCount > prevVerificationCount.current) {
      addLog(`Verification popup auto-dismissed (#${status.verificationCount})`, "success");
    }

    prevRunning.current = status.running;
    prevNeedsLogin.current = status.needsLogin;
    prevEarning.current = status.earning;
    prevVerificationCount.current = status.verificationCount;
  }, [status, toast]);

  // ─── Earnings data via dedicated endpoint ─────────────────────────────────

  const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

  const { data: earningsData, refetch: refetchEarnings } = useQuery({
    queryKey: ["bot-earnings"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/bot/earnings`);
      if (!res.ok) throw new Error("Failed to fetch earnings");
      return res.json() as Promise<{
        current: number | null;
        history: { value: number; timestamp: number }[];
      }>;
    },
    refetchInterval: 60_000,
    enabled: status?.running ?? false,
  });

  const earningsChartData = (earningsData?.history ?? []).map((p) => ({
    value: p.value,
    time: new Date(p.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
  }));

  // ─── Auto-restart toggle ──────────────────────────────────────────────────

  const toggleAutoRestart = async () => {
    const newVal = !(status?.autoRestart ?? true);
    try {
      await fetch("/api/bot/auto-restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: newVal }),
      });
      queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
      addLog(`Auto-restart ${newVal ? "ENABLED" : "DISABLED"}`, newVal ? "success" : "warning");
    } catch {
      addLog("Failed to toggle auto-restart", "error");
    }
  };

  // ─── Viewport click ───────────────────────────────────────────────────────

  const handleViewportClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!status?.running) {
      addLog("Cannot interact while bot is stopped", "warning");
      return;
    }
    if (!viewportRef.current) return;
    const rect = viewportRef.current.getBoundingClientRect();
    const pctX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const pctY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    const targetX = Math.round(pctX * 1024);
    const targetY = Math.round(pctY * 640);
    addLog(`Click at [${targetX}, ${targetY}]`, "info");
    setIsClicking(true);
    botClick.mutate({ data: { x: targetX, y: targetY } });
  };

  // ─── Keyboard input ───────────────────────────────────────────────────────

  const handleSendText = () => {
    if (!typeInput.trim() || !status?.running || botType.isPending) return;
    botType.mutate({ data: { text: typeInput } });
  };

  const handleTypeKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (typeInput.trim()) {
        handleSendText();
      } else {
        // Empty Enter = press Enter key in browser
        addLog("Pressed Enter in browser", "info");
        botType.mutate({ data: { text: "\n" } });
      }
    }
  };

  return (
    <div className="min-h-[100dvh] bg-background text-foreground p-4 md:p-6 lg:p-8 font-mono">
      <div className="max-w-7xl mx-auto space-y-6">

        {/* HEADER */}
        <header className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between bg-card border border-border p-4 rounded-xl shadow-sm">
          <div className="flex items-center gap-3">
            <Terminal className="w-6 h-6 text-primary" />
            <div>
              <h1 className="text-xl font-bold tracking-tight">
                BLAZENODE<span className="text-primary opacity-80">_TERM</span>
              </h1>
              <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  {status?.running ? (
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                    </span>
                  ) : (
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-destructive"></span>
                  )}
                  {status?.running ? "SYSTEM ACTIVE" : "SYSTEM OFFLINE"}
                </span>
                <span>•</span>
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  UPTIME: {formatUptime(displayUptime)}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            {status?.earning && (
              <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 font-mono rounded-sm flex items-center gap-1">
                <Coins className="w-3 h-3" />
                EARNING
              </Badge>
            )}
            {status?.sessionActive && !status?.earning && (
              <Badge variant="outline" className="bg-blue-500/10 text-blue-400 border-blue-500/20 font-mono rounded-sm">
                SESSION_VALID
              </Badge>
            )}
            {(status?.verificationCount ?? 0) > 0 && (
              <Badge variant="outline" className="bg-orange-500/10 text-orange-400 border-orange-500/20 font-mono rounded-sm flex items-center gap-1">
                <ShieldCheck className="w-3 h-3" />
                VERIFIED×{status?.verificationCount}
              </Badge>
            )}
            {(status?.crashCount ?? 0) > 0 && (
              <Badge variant="outline" className="bg-red-500/10 text-red-400 border-red-500/20 font-mono rounded-sm flex items-center gap-1">
                <RefreshCw className="w-3 h-3" />
                RESTARTED×{status?.crashCount}
              </Badge>
            )}
            <button
              onClick={toggleAutoRestart}
              title={status?.autoRestart ? "Auto-restart ON — click to disable" : "Auto-restart OFF — click to enable"}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-sm border font-mono text-xs transition-colors ${
                status?.autoRestart
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20"
                  : "bg-muted/30 text-muted-foreground border-border hover:bg-muted/50"
              }`}
            >
              <RefreshCw className={`w-3 h-3 ${status?.autoRestart ? "animate-spin [animation-duration:3s]" : ""}`} />
              AUTO_RST:{status?.autoRestart ? "ON" : "OFF"}
            </button>
            <div className="flex bg-background border border-border rounded-md p-1 gap-0.5">
              <Button
                variant={status?.running ? "secondary" : "default"}
                size="sm"
                className={`font-mono text-xs rounded-sm transition-all ${status?.running ? "opacity-50" : ""}`}
                onClick={() => startBot.mutate()}
                disabled={status?.running || startBot.isPending}
              >
                <Play className="w-3.5 h-3.5 mr-1.5" />
                INIT_START
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="font-mono text-xs rounded-sm transition-all border-amber-500/40 text-amber-400 hover:bg-amber-500/10 hover:text-amber-300"
                onClick={restartBot}
                disabled={isRestarting}
                title="Stop then start the bot"
              >
                {isRestarting
                  ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
                RESTART
              </Button>
              <Button
                variant={status?.running ? "destructive" : "secondary"}
                size="sm"
                className={`font-mono text-xs rounded-sm transition-all ${!status?.running ? "opacity-50" : ""}`}
                onClick={() => stopBot.mutate()}
                disabled={!status?.running || stopBot.isPending}
              >
                <Square className="w-3.5 h-3.5 mr-1.5" />
                HALT
              </Button>
            </div>
          </div>
        </header>

        {/* LOGIN BANNER */}
        <AnimatePresence>
          {status?.needsLogin && (
            <motion.div
              initial={{ opacity: 0, height: 0, y: -10 }}
              animate={{ opacity: 1, height: "auto", y: 0 }}
              exit={{ opacity: 0, height: 0, y: -10 }}
            >
              <Alert variant="destructive" className="bg-destructive/10 border-destructive/20 text-destructive shadow-sm">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle className="font-bold">AUTH_REQUIRED</AlertTitle>
                <AlertDescription className="mt-1">
                  Click "Continue with Google" in the viewport, then use the keyboard bar below the viewport to type your email and press Enter.
                </AlertDescription>
              </Alert>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">

          {/* LEFT COLUMN: AUTO LOGIN + VIEWPORT + KEYBOARD */}
          <div className="lg:col-span-3 flex flex-col gap-4">

          {/* AUTO LOGIN PANEL */}
          <AutoLoginPanel />
            <div className="flex items-center justify-between text-xs font-bold text-muted-foreground uppercase tracking-widest px-1">
              <span>Primary Viewport // [1024x640]</span>
              <span className="flex items-center gap-2">
                <Activity className="w-3 h-3 text-primary" />
                {status?.running ? "LIVE_FEED" : "NO_SIGNAL"}
              </span>
            </div>

            {/* Viewport */}
            <div
              className={`relative rounded-lg overflow-hidden border-2 bg-[#0a0a0a] shadow-lg group ${status?.running ? "border-primary/30 cursor-crosshair hover:border-primary/60 transition-colors" : "border-border/50"}`}
              style={{ aspectRatio: "16/10" }}
            >
              <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-[length:100%_4px,3px_100%] z-10 opacity-20"></div>

              {!status?.running ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
                  <Terminal className="w-12 h-12 mb-4 opacity-20" />
                  <p className="uppercase tracking-widest text-sm opacity-50">Connection Refused</p>
                </div>
              ) : baseSrc ? (
                <div ref={viewportRef} className="absolute inset-0 w-full h-full" onClick={handleViewportClick}>
                  {/* Base layer — always fully visible, never flickers */}
                  <img
                    src={`data:image/jpeg;base64,${baseSrc}`}
                    alt="Browser Feed"
                    className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                  />
                  {/* Incoming layer — fades in on top, then gets promoted to base */}
                  {fadeSrc && (
                    <img
                      src={`data:image/jpeg;base64,${fadeSrc}`}
                      alt=""
                      className="absolute inset-0 w-full h-full object-contain pointer-events-none transition-opacity duration-[400ms] ease-in-out"
                      style={{ opacity: fadeSrc ? 1 : 0 }}
                    />
                  )}
                  <AnimatePresence>
                    {isClicking && (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute inset-0 bg-background/50 backdrop-blur-[2px] flex items-center justify-center z-20"
                      >
                        <div className="flex flex-col items-center gap-3">
                          <Loader2 className="w-8 h-8 animate-spin text-primary" />
                          <span className="text-primary font-bold text-sm tracking-widest bg-background/80 px-3 py-1 rounded">SENDING_COORD...</span>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              ) : (
                <div className="absolute inset-0 flex items-center justify-center">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              )}
            </div>

            {/* Keyboard Input Bar */}
            <AnimatePresence>
              {status?.running && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2"
                >
                  <Keyboard className="w-4 h-4 text-muted-foreground shrink-0" />
                  <Input
                    ref={typeInputRef}
                    value={typeInput}
                    onChange={(e) => setTypeInput(e.target.value)}
                    onKeyDown={handleTypeKeyDown}
                    placeholder="Click viewport first, then type here and press Enter..."
                    className="flex-1 bg-transparent border-none shadow-none focus-visible:ring-0 font-mono text-sm h-7 px-1 placeholder:text-muted-foreground/50"
                    disabled={!status?.running || botType.isPending}
                  />
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs font-mono text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        addLog("Pressed Enter in browser", "info");
                        botType.mutate({ data: { text: "\n" } });
                      }}
                      disabled={!status?.running || botType.isPending}
                      title="Send Enter key"
                    >
                      <CornerDownLeft className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      className="h-7 px-3 text-xs font-mono"
                      onClick={handleSendText}
                      disabled={!typeInput.trim() || !status?.running || botType.isPending}
                    >
                      {botType.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                    </Button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* RIGHT COLUMN: EVENT LOG + EARNINGS TRACK */}
          <div className="lg:col-span-1 flex flex-col gap-4">
            <div className="flex items-center justify-between text-xs font-bold text-muted-foreground uppercase tracking-widest px-1">
              <span>Event_Log</span>
              {status?.lastActivity && (
                <span className="text-[10px] opacity-70">
                  Last: {formatDistanceToNow(new Date(status.lastActivity), { addSuffix: true })}
                </span>
              )}
            </div>
            <Card className="flex-1 bg-card/50 backdrop-blur-sm border-border overflow-hidden flex flex-col shadow-inner">
              <CardContent className="p-0 flex-1 flex flex-col">
                <ScrollArea className="flex-1 h-full max-h-[calc(100vh-300px)] p-4">
                  <div className="space-y-3">
                    <AnimatePresence initial={false}>
                      {logs.map((log) => (
                        <motion.div
                          key={log.id}
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          className="flex gap-2 text-sm items-start"
                        >
                          <span className="text-[10px] text-muted-foreground opacity-50 whitespace-nowrap mt-1">
                            {log.time.toLocaleTimeString([], { hour12: false })}
                          </span>
                          <span className={`leading-tight flex-1
                            ${log.type === "error" ? "text-destructive font-bold" : ""}
                            ${log.type === "success" ? "text-emerald-400" : ""}
                            ${log.type === "warning" ? "text-amber-400" : ""}
                            ${log.type === "info" ? "text-foreground" : ""}
                          `}>
                            {log.message}
                          </span>
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>

            {/* EARNINGS TRACK CHART */}
            {status?.running && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between text-xs font-bold text-muted-foreground uppercase tracking-widest px-1">
                  <span className="flex items-center gap-1.5">
                    <TrendingUp className="w-3 h-3 text-emerald-400" />
                    Earnings_Track
                  </span>
                  <span className="flex items-center gap-2">
                    {earningsData?.current != null ? (
                      <span className="text-emerald-400 font-mono">
                        CURRENT: {earningsData.current.toFixed(2)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/50">No data yet</span>
                    )}
                    <button
                      className="text-muted-foreground/60 hover:text-emerald-400 transition-colors"
                      title="Force read earnings now"
                      onClick={async () => {
                        await fetch(`${BASE}/api/bot/earnings/read-now`, { method: "POST" });
                        refetchEarnings();
                      }}
                    >
                      <RefreshCw className="w-3 h-3" />
                    </button>
                  </span>
                </div>

                <Card className="bg-card/50 border-border shadow-inner">
                  <CardContent className="p-4">
                    {earningsChartData.length === 0 ? (
                      <div className="h-32 flex items-center justify-center text-xs text-muted-foreground/40 font-mono uppercase tracking-widest">
                        Awaiting first earnings reading…
                      </div>
                    ) : (
                      <ResponsiveContainer width="100%" height={160}>
                        <LineChart data={earningsChartData} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                          <XAxis
                            dataKey="time"
                            tick={{ fontSize: 10, fill: "rgba(255,255,255,0.3)", fontFamily: "monospace" }}
                            tickLine={false}
                            axisLine={false}
                            interval="preserveStartEnd"
                          />
                          <YAxis
                            tick={{ fontSize: 10, fill: "rgba(255,255,255,0.3)", fontFamily: "monospace" }}
                            tickLine={false}
                            axisLine={false}
                            width={48}
                          />
                          <Tooltip
                            contentStyle={{
                              background: "hsl(var(--card))",
                              border: "1px solid hsl(var(--border))",
                              borderRadius: "6px",
                              fontSize: "11px",
                              fontFamily: "monospace",
                              color: "hsl(var(--foreground))",
                            }}
                            labelStyle={{ color: "rgba(255,255,255,0.5)", marginBottom: 4 }}
                            formatter={(v: number) => [v.toFixed(4), "Earned"]}
                          />
                          <Line
                            type="monotone"
                            dataKey="value"
                            stroke="#10b981"
                            strokeWidth={2}
                            dot={{ fill: "#10b981", r: 3 }}
                            activeDot={{ r: 5, fill: "#34d399" }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
