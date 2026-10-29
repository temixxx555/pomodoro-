/**
 * Tiny external store for the timer's persisted state.
 *
 * Reading from localStorage inside an effect and calling setState there is
 * discouraged by React (and flagged by the compiler lint rules). Using
 * useSyncExternalStore instead gives us a single source of truth that survives
 * hydration, works with SSR, and keeps every tab in sync.
 */

export type Settings = {
  focus: number;
  shortBreak: number;
  longBreak: number;
  longBreakInterval: number;
  autoStartBreaks: boolean;
  autoStartFocus: boolean;
  volume: number;
  notifications: boolean;
};

export type Stats = {
  date: string;
  sessions: number;
  focusSeconds: number;
  cycle: number;
};

export type Theme = "light" | "dark";

export type Snapshot = {
  settings: Settings;
  stats: Stats;
  theme: Theme;
};

export const DEFAULT_SETTINGS: Settings = {
  focus: 25,
  shortBreak: 5,
  longBreak: 15,
  longBreakInterval: 4,
  autoStartBreaks: true,
  autoStartFocus: false,
  volume: 0.6,
  notifications: false,
};

const SETTINGS_KEY = "pomodoro.settings.v2";
const STATS_KEY = "pomodoro.stats.v2";
const THEME_KEY = "pomodoro.theme";

const listeners = new Set<() => void>();

let snapshot: Snapshot | null = null;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Accepts both raw (`dark`) and JSON-quoted (`"dark"`) values. */
function parseTheme(raw: string | null): Theme | null {
  if (!raw) return null;
  const value = raw.replace(/^"|"$/g, "");
  return value === "dark" || value === "light" ? value : null;
}

function emptyStats(): Stats {
  return { date: todayKey(), sessions: 0, focusSeconds: 0, cycle: 0 };
}

const SERVER_SNAPSHOT: Snapshot = {
  settings: DEFAULT_SETTINGS,
  stats: { date: "", sessions: 0, focusSeconds: 0, cycle: 0 },
  theme: "light",
};

function read(): Snapshot {
  if (snapshot) return snapshot;

  const next: Snapshot = {
    settings: { ...DEFAULT_SETTINGS },
    stats: emptyStats(),
    theme: "light",
  };

  if (typeof window !== "undefined") {
    try {
      const rawSettings = window.localStorage.getItem(SETTINGS_KEY);
      if (rawSettings) {
        next.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(rawSettings) };
      }

      const rawStats = window.localStorage.getItem(STATS_KEY);
      if (rawStats) {
        const parsed = JSON.parse(rawStats) as Stats;
        // Only keep stats from today; a new day starts fresh.
        if (parsed.date === todayKey()) {
          next.stats = { ...emptyStats(), ...parsed };
        }
      }

      const storedTheme = parseTheme(window.localStorage.getItem(THEME_KEY));
      next.theme =
        storedTheme ??
        (window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light");
    } catch {
      /* ignore corrupt storage */
    }
  }

  snapshot = next;
  return next;
}

function persist(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage may be unavailable (private mode, quota) */
  }
}

function emit() {
  listeners.forEach((listener) => listener());
}

function commit(next: Snapshot) {
  snapshot = next;
  emit();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): Snapshot {
  return read();
}

export function getServerSnapshot(): Snapshot {
  return SERVER_SNAPSHOT;
}

export function updateSettings(patch: Partial<Settings>): void {
  const current = read();
  const next: Snapshot = {
    ...current,
    settings: { ...current.settings, ...patch },
  };
  persist(SETTINGS_KEY, next.settings);
  commit(next);
}

export function setTheme(theme: Theme): void {
  const current = read();
  if (typeof window !== "undefined") {
    try {
      // Stored raw (not JSON) so the pre-paint script can read it directly.
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
  }
  commit({ ...current, theme });
}

/** Records a finished focus session and returns the new cycle count. */
export function recordFocus(seconds: number): number {
  const current = read();
  const stats: Stats = {
    ...current.stats,
    sessions: current.stats.sessions + 1,
    focusSeconds: current.stats.focusSeconds + Math.max(0, Math.round(seconds)),
    cycle: current.stats.cycle + 1,
  };
  persist(STATS_KEY, stats);
  commit({ ...current, stats });
  return stats.cycle;
}

export function resetCycle(): void {
  const current = read();
  const stats: Stats = { ...current.stats, cycle: 0 };
  persist(STATS_KEY, stats);
  commit({ ...current, stats });
}

export function resetStats(): void {
  const current = read();
  const stats = emptyStats();
  persist(STATS_KEY, stats);
  commit({ ...current, stats });
}

// Keep multiple open tabs in sync.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (
      event.key === SETTINGS_KEY ||
      event.key === STATS_KEY ||
      event.key === THEME_KEY
    ) {
      snapshot = null;
      emit();
    }
  });
}
