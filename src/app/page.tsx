"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { alarm } from "@/lib/alarm";
import {
  DEFAULT_SETTINGS,
  getServerSnapshot,
  getSnapshot,
  recordFocus,
  resetCycle,
  resetStats,
  setTheme,
  subscribe,
  updateSettings,
  type Settings,
} from "@/lib/store";

type Mode = "focus" | "shortBreak" | "longBreak" | "quick";
type Status = "idle" | "running" | "paused" | "ringing";

const MODE_META: Record<
  Mode,
  { label: string; tab: string; accent: string; glow: string }
> = {
  focus: {
    label: "Focus",
    tab: "Focus",
    accent: "#f43f5e",
    glow: "rgba(244,63,94,0.35)",
  },
  shortBreak: {
    label: "Short Break",
    tab: "Short Break",
    accent: "#10b981",
    glow: "rgba(16,185,129,0.35)",
  },
  longBreak: {
    label: "Long Break",
    tab: "Long Break",
    accent: "#0ea5e9",
    glow: "rgba(14,165,233,0.35)",
  },
  quick: {
    label: "Quick Timer",
    tab: "Quick",
    accent: "#a855f7",
    glow: "rgba(168,85,247,0.35)",
  },
};

const TABS: Mode[] = ["focus", "shortBreak", "longBreak"];
const QUICK_PRESETS = [10, 30, 60, 300];
const RING_RADIUS = 118;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// Applies the theme before paint on the client; no-op during SSR.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

function durationFor(mode: Mode, settings: Settings, quickSeconds: number) {
  if (mode === "quick") return quickSeconds * 1000;
  return settings[mode] * 60 * 1000;
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export default function Home() {
  const { settings, stats, theme } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const [mode, setMode] = useState<Mode>("focus");
  const [status, setStatus] = useState<Status>("idle");
  const [remainingMs, setRemainingMs] = useState(DEFAULT_SETTINGS.focus * 60000);
  const [quickSeconds, setQuickSeconds] = useState(10);
  const [showSettings, setShowSettings] = useState(false);

  const endsAtRef = useRef(0);
  const startedAtRef = useRef(0);
  const elapsedRef = useRef(0);
  const nextModeRef = useRef<Mode>("shortBreak");
  const finishingRef = useRef(false);

  const duration = durationFor(mode, settings, quickSeconds);
  // While idle the clock is derived from settings, so changing a duration
  // updates the display immediately without an effect.
  const displayMs = status === "idle" ? duration : remainingMs;

  /* ----------------------------- external sync ------------------------------ */

  useIsomorphicLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    alarm.setVolume(settings.volume);
  }, [settings.volume]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void alarm.unlock();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  useEffect(() => {
    const active = status !== "idle";
    document.title = active
      ? `${formatTime(displayMs)} · ${MODE_META[mode].label}`
      : "Pomodoro Timer";
  }, [displayMs, status, mode]);

  /* --------------------------------- timing -------------------------------- */

  const finish = useCallback(() => {
    if (finishingRef.current) return;
    finishingRef.current = true;

    alarm.start(settings.volume);
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate([400, 200, 400, 200, 400]);
    }

    // Count only time actually spent running (pauses are excluded).
    if (startedAtRef.current) {
      elapsedRef.current += Date.now() - startedAtRef.current;
      startedAtRef.current = 0;
    }
    const focusedSeconds = elapsedRef.current / 1000;
    elapsedRef.current = 0;

    const wasFocus = mode === "focus";
    let next: Mode;

    if (wasFocus) {
      const cycle = recordFocus(focusedSeconds);
      next =
        cycle % settings.longBreakInterval === 0 ? "longBreak" : "shortBreak";
    } else {
      if (mode === "longBreak") resetCycle();
      next = "focus";
    }

    nextModeRef.current = next;
    setStatus("ringing");

    if (
      settings.notifications &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      new Notification(wasFocus ? "Focus session complete 🍅" : "Break over ☕", {
        body: wasFocus
          ? `Time for a ${next === "longBreak" ? "long" : "short"} break.`
          : "Ready to focus again?",
        tag: "pomodoro",
      });
    }
  }, [mode, settings.volume, settings.longBreakInterval, settings.notifications]);

  // Timestamp-based countdown: stays accurate even when the tab is throttled.
  useEffect(() => {
    if (status !== "running") return;

    const id = window.setInterval(() => {
      const left = endsAtRef.current - Date.now();
      if (left <= 0) {
        setRemainingMs(0);
        finish();
      } else {
        setRemainingMs(left);
      }
    }, 200);

    return () => window.clearInterval(id);
  }, [status, finish]);

  /* --------------------------------- actions -------------------------------- */

  const start = useCallback(() => {
    void alarm.unlock();
    finishingRef.current = false;

    const from = status === "idle" ? duration : remainingMs;
    startedAtRef.current = Date.now();
    endsAtRef.current = Date.now() + from;
    setRemainingMs(from);
    setStatus("running");
  }, [status, duration, remainingMs]);

  const pause = useCallback(() => {
    if (startedAtRef.current) {
      elapsedRef.current += Date.now() - startedAtRef.current;
      startedAtRef.current = 0;
    }
    setRemainingMs(Math.max(0, endsAtRef.current - Date.now()));
    setStatus("paused");
  }, []);

  const reset = useCallback(() => {
    alarm.stop();
    finishingRef.current = false;
    startedAtRef.current = 0;
    elapsedRef.current = 0;
    setRemainingMs(duration);
    setStatus("idle");
  }, [duration]);

  const stopAlarm = useCallback(() => {
    alarm.stop();
    finishingRef.current = false;
    startedAtRef.current = 0;
    elapsedRef.current = 0;

    const next = nextModeRef.current;
    const nextDuration = durationFor(next, settings, quickSeconds);
    setMode(next);
    setRemainingMs(nextDuration);

    const autoStart =
      next === "focus" ? settings.autoStartFocus : settings.autoStartBreaks;

    if (autoStart) {
      startedAtRef.current = Date.now();
      endsAtRef.current = Date.now() + nextDuration;
      setStatus("running");
    } else {
      setStatus("idle");
    }
  }, [settings, quickSeconds]);

  const selectMode = useCallback((next: Mode) => {
    alarm.stop();
    finishingRef.current = false;
    startedAtRef.current = 0;
    elapsedRef.current = 0;
    setStatus("idle");
    setMode(next);
  }, []);

  const startQuick = useCallback((seconds: number) => {
    alarm.stop();
    finishingRef.current = false;
    startedAtRef.current = Date.now();
    elapsedRef.current = 0;
    setQuickSeconds(seconds);
    setMode("quick");
    setRemainingMs(seconds * 1000);
    endsAtRef.current = Date.now() + seconds * 1000;
    setStatus("running");
    void alarm.unlock();
  }, []);

  const skip = useCallback(() => {
    if (status === "ringing") {
      stopAlarm();
      return;
    }
    alarm.stop();
    finishingRef.current = false;
    startedAtRef.current = 0;
    elapsedRef.current = 0;
    const next: Mode = mode === "focus" ? "shortBreak" : "focus";
    nextModeRef.current = next;
    setStatus("idle");
    setMode(next);
  }, [mode, status, stopAlarm]);

  const toggle = useCallback(() => {
    if (status === "ringing") {
      stopAlarm();
    } else if (status === "running") {
      pause();
    } else {
      start();
    }
  }, [status, stopAlarm, pause, start]);

  /* ------------------------------- shortcuts -------------------------------- */

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key.toLowerCase()) {
        case " ":
          event.preventDefault();
          toggle();
          break;
        case "r":
          reset();
          break;
        case "s":
          skip();
          break;
        case "escape":
          setShowSettings(false);
          break;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, reset, skip]);

  /* ------------------------------- presentation ----------------------------- */

  const progress = duration > 0 ? 1 - displayMs / duration : 0;
  const meta = MODE_META[mode];
  const isRinging = status === "ringing";

  const dots = Math.max(1, settings.longBreakInterval);
  const filledDots =
    stats.cycle === 0
      ? 0
      : stats.cycle % dots === 0
        ? dots
        : stats.cycle % dots;

  return (
    <div className="relative min-h-screen  bg-zinc-50 text-zinc-900 transition-colors dark:bg-zinc-950 dark:text-zinc-50">
      <div
        className="pointer-events-none absolute -top-40 left-1/2 h-[32rem] w-[32rem] -translate-x-1/2 rounded-full blur-3xl transition-colors duration-700"
        style={{ background: meta.glow, opacity: 0.45 }}
      />

      <div className="relative mx-auto flex min-h-screen w-full max-w-xl flex-col px-5 py-8">
        <header className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span
              className="flex h-9 w-9 items-center justify-center rounded-xl text-lg shadow-sm"
              style={{ background: meta.accent, color: "#fff" }}
            >
              🍅
            </span>
            <div>
              <h1 className="text-lg font-semibold leading-tight">Pomodoro</h1>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {stats.sessions} session{stats.sessions === 1 ? "" : "s"} today ·{" "}
                {Math.round(stats.focusSeconds / 60)} min focused
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label="Toggle theme"
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-200 bg-white/70 text-base transition hover:bg-white dark:border-zinc-800 dark:bg-zinc-900/70 dark:hover:bg-zinc-900"
            >
              {theme === "dark" ? "☀️" : "🌙"}
            </button>
            <button
              onClick={() => setShowSettings(true)}
              aria-label="Open settings"
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-200 bg-white/70 text-base transition hover:bg-white dark:border-zinc-800 dark:bg-zinc-900/70 dark:hover:bg-zinc-900"
            >
              ⚙️
            </button>
          </div>
        </header>

        <div className="mb-7 grid grid-cols-3 gap-1 rounded-2xl bg-zinc-200/60 p-1 dark:bg-zinc-900">
          {TABS.map((tab) => {
            const active = mode === tab;
            return (
              <button
                key={tab}
                onClick={() => selectMode(tab)}
                className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                  active
                    ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-50"
                    : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                }`}
              >
                {MODE_META[tab].tab}
              </button>
            );
          })}
        </div>

        <div className="relative mx-auto aspect-square w-full max-w-[20rem]">
          <svg viewBox="0 0 280 280" className="h-full w-full -rotate-90">
            <circle
              cx="140"
              cy="140"
              r={RING_RADIUS}
              fill="none"
              strokeWidth="10"
              className="stroke-zinc-200 dark:stroke-zinc-800"
            />
            <circle
              cx="140"
              cy="140"
              r={RING_RADIUS}
              fill="none"
              strokeWidth="10"
              strokeLinecap="round"
              style={{
                stroke: meta.accent,
                strokeDasharray: RING_CIRCUMFERENCE,
                strokeDashoffset: RING_CIRCUMFERENCE * (1 - progress),
                transition: "stroke-dashoffset 0.25s linear",
              }}
            />
          </svg>

          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span
              className={`font-mono text-6xl font-semibold tracking-tight ${
                isRinging ? "animate-pulse" : ""
              }`}
              style={isRinging ? { color: meta.accent } : undefined}
            >
              {formatTime(displayMs)}
            </span>
            <span className="mt-2 text-sm font-medium uppercase tracking-[0.2em] text-zinc-500 dark:text-zinc-400">
              {isRinging
                ? "Time's up"
                : status === "paused"
                  ? "Paused"
                  : meta.label}
            </span>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-center gap-2">
          {Array.from({ length: dots }).map((_, i) => (
            <span
              key={i}
              className="h-2 w-2 rounded-full transition-colors"
              style={{
                background:
                  i < filledDots ? meta.accent : "rgba(113,113,122,0.28)",
              }}
            />
          ))}
          <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
            {filledDots}/{dots} to long break
          </span>
        </div>

        <div className="mt-7 flex items-center justify-center gap-3">
          <button
            onClick={reset}
            aria-label="Reset timer"
            className="flex h-12 w-12 items-center justify-center rounded-2xl border border-zinc-200 bg-white/70 text-lg transition hover:bg-white dark:border-zinc-800 dark:bg-zinc-900/70 dark:hover:bg-zinc-900"
          >
            ↺
          </button>

          <button
            onClick={toggle}
            className="flex h-16 min-w-[9.5rem] items-center justify-center gap-2 rounded-2xl px-8 text-base font-semibold text-white shadow-lg transition active:scale-[0.98]"
            style={{
              background: isRinging
                ? "#dc2626"
                : status === "running"
                  ? "#f59e0b"
                  : meta.accent,
              boxShadow: `0 12px 30px -10px ${
                isRinging ? "rgba(220,38,38,0.7)" : meta.glow
              }`,
            }}
          >
            {isRinging
              ? "Stop Alarm"
              : status === "running"
                ? "Pause"
                : status === "paused"
                  ? "Resume"
                  : "Start"}
          </button>

          <button
            onClick={skip}
            aria-label="Skip to next session"
            className="flex h-12 w-12 items-center justify-center rounded-2xl border border-zinc-200 bg-white/70 text-lg transition hover:bg-white dark:border-zinc-800 dark:bg-zinc-900/70 dark:hover:bg-zinc-900"
          >
            ⏭
          </button>
        </div>

        <div className="mt-7 rounded-2xl border border-zinc-200 bg-white/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
          <p className="mb-2 px-1 text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Quick timers
          </p>
          <div className="grid grid-cols-4 gap-2">
            {QUICK_PRESETS.map((seconds) => (
              <button
                key={seconds}
                onClick={() => startQuick(seconds)}
                className="rounded-xl border border-zinc-200 bg-white px-2 py-2 text-sm font-medium text-zinc-700 transition hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
              >
                {seconds < 60 ? `${seconds}s` : `${seconds / 60}m`}
              </button>
            ))}
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-zinc-400 dark:text-zinc-500">
          <kbd className="rounded border border-zinc-300 px-1.5 py-0.5 dark:border-zinc-700">
            Space
          </kbd>{" "}
          start/pause ·{" "}
          <kbd className="rounded border border-zinc-300 px-1.5 py-0.5 dark:border-zinc-700">
            R
          </kbd>{" "}
          reset ·{" "}
          <kbd className="rounded border border-zinc-300 px-1.5 py-0.5 dark:border-zinc-700">
            S
          </kbd>{" "}
          skip
        </p>
      </div>

      {showSettings && (
        <SettingsPanel onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { settings } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    updateSettings({ [key]: value } as Partial<Settings>);

  const requestNotifications = async (enabled: boolean) => {
    if (!enabled) {
      update("notifications", false);
      return;
    }
    if (typeof Notification === "undefined") return;
    const permission = await Notification.requestPermission();
    update("notifications", permission === "granted");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-6 shadow-2xl dark:bg-zinc-900 sm:rounded-3xl"
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Settings</h2>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            ✕
          </button>
        </div>

        <div className="space-y-5">
          <NumberField
            label="Focus length"
            suffix="min"
            value={settings.focus}
            min={1}
            max={120}
            onChange={(v) => update("focus", v)}
          />
          <NumberField
            label="Short break"
            suffix="min"
            value={settings.shortBreak}
            min={1}
            max={30}
            onChange={(v) => update("shortBreak", v)}
          />
          <NumberField
            label="Long break"
            suffix="min"
            value={settings.longBreak}
            min={1}
            max={60}
            onChange={(v) => update("longBreak", v)}
          />
          <NumberField
            label="Long break every"
            suffix="sessions"
            value={settings.longBreakInterval}
            min={2}
            max={8}
            onChange={(v) => update("longBreakInterval", v)}
          />

          <div>
            <label className="mb-2 flex items-center justify-between text-sm font-medium">
              <span>Alarm volume</span>
              <span className="text-zinc-500 dark:text-zinc-400">
                {Math.round(settings.volume * 100)}%
              </span>
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.volume}
              onChange={(event) => update("volume", Number(event.target.value))}
              className="w-full accent-rose-500"
            />
            <button
              onClick={() => {
                void alarm.unlock().then(() => alarm.blip());
              }}
              className="mt-2 text-xs font-medium text-rose-500 hover:underline"
            >
              Test sound
            </button>
          </div>

          <Toggle
            label="Auto-start breaks"
            description="Begin the break as soon as you stop the alarm"
            checked={settings.autoStartBreaks}
            onChange={(v) => update("autoStartBreaks", v)}
          />
          <Toggle
            label="Auto-start focus"
            description="Jump straight back into focus after a break"
            checked={settings.autoStartFocus}
            onChange={(v) => update("autoStartFocus", v)}
          />
          <Toggle
            label="Desktop notifications"
            description="Show a system notification when a timer ends"
            checked={settings.notifications}
            onChange={requestNotifications}
          />

          <div className="flex items-center justify-between border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <div>
              <p className="text-sm font-medium">Today&apos;s progress</p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Clear session count and focus minutes
              </p>
            </div>
            <button
              onClick={resetStats}
              className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              Reset
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function NumberField({
  label,
  suffix,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  suffix: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <label className="text-sm font-medium">{label}</label>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onChange(Math.max(min, value - 1))}
          aria-label={`Decrease ${label}`}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 text-zinc-600 transition hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          −
        </button>
        <div className="flex w-24 items-center justify-center gap-1 rounded-lg border border-zinc-200 px-2 py-1.5 text-sm dark:border-zinc-700">
          <input
            type="number"
            value={value}
            min={min}
            max={max}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (!Number.isNaN(next)) {
                onChange(Math.min(max, Math.max(min, next)));
              }
            }}
            className="w-10 bg-transparent text-center font-medium outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
          />
          <span className="text-xs text-zinc-500 dark:text-zinc-400">{suffix}</span>
        </div>
        <button
          onClick={() => onChange(Math.min(max, value + 1))}
          aria-label={`Increase ${label}`}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 text-zinc-600 transition hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          +
        </button>
      </div>
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${
          checked ? "bg-rose-500" : "bg-zinc-300 dark:bg-zinc-700"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-[1.375rem]" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}
