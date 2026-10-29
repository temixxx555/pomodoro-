/**
 * Alarm that generates its own ring tone with the Web Audio API.
 *
 * - No audio files, no network requests, no CORS problems; works offline.
 * - iOS-safe: works with the silent switch on (iOS 16.4+ via Audio Session API,
 *   older iOS via a silent looping <audio> element), recovers from the
 *   "interrupted" state, and unlocks itself on the first user gesture.
 * - Rings are scheduled a few seconds ahead on the audio clock, so the alarm
 *   keeps sounding even if the browser throttles timers.
 * - Optional screen wake lock so the phone doesn't lock while the page waits.
 *
 * Usage:
 *   alarm.armAutoUnlock();          // once at app start; unlocks on first tap
 *   await alarm.unlock();           // or call directly inside a click handler
 *   alarm.start(0.8);               // ring until stop()
 *   alarm.stop();
 *   alarm.blip();                   // short "test sound"
 */

type AudioSessionNavigator = Navigator & { audioSession?: { type: string } };

type WakeLockLike = { release(): Promise<void> };
type WakeLockNavigator = Navigator & {
  wakeLock?: { request(type: "screen"): Promise<WakeLockLike> };
};

// A classic two-tone "ring ring" pattern.
const RING_NOTES = [880, 1174.66, 880, 1174.66];
const NOTE_SPACING = 0.16; // seconds between beeps
const RING_PAUSE = 1.4; // seconds of silence between rings
const RING_PERIOD = RING_NOTES.length * NOTE_SPACING + RING_PAUSE;

const LOOKAHEAD = 3; // schedule this many seconds of rings ahead of time
const TICK_MS = 500; // scheduler interval
const RESUME_RETRY_MS = 2000; // minimum gap between automatic resume attempts

const GESTURE_EVENTS = ["touchend", "pointerup", "click", "keydown"] as const;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Builds a tiny silent WAV and returns an object URL for it. */
function createSilentWavUrl(): string {
  const sampleRate = 8000;
  const samples = 800; // 0.1 s
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, samples * 2, true);
  // Sample data stays zeroed = silence.

  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    // iPadOS reports itself as a Mac.
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export class AlarmSound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private session: GainNode | null = null; // per-ring-session bus, faded on stop()
  private liveNodes = new Set<OscillatorNode>();

  private active = false;
  private volume = 0.6;
  private schedulerId: number | null = null;
  private nextRingTime = 0;
  private lastResumeTry = 0;

  private primed = false; // silent buffer already played
  private gesturesArmed = false;
  private listenersBound = false;

  private silentAudio: HTMLAudioElement | null = null;
  private silentUrl: string | null = null;

  private wakeLock: WakeLockLike | null = null;
  private wantAwake = false;

  /* ------------------------------------------------------------------ */
  /* Public API                                                          */
  /* ------------------------------------------------------------------ */

  /** True once the audio context exists and is actually running. */
  get isUnlocked(): boolean {
    return this.ctx?.state === "running";
  }

  get isRinging(): boolean {
    return this.active;
  }

  /**
   * Unlocks audio. Call it directly inside a click/touch handler (before any
   * `await`), or use armAutoUnlock() to do it on the first user gesture.
   */
  async unlock(): Promise<void> {
    if (typeof window === "undefined") return;

    this.configureAudioSession();
    this.ensureContext();
    this.startSilentElementIfNeeded(); // must happen inside the gesture
    this.playSilentBuffer();
    await this.ensureRunning(1000);

    if (this.isUnlocked) this.disarmAutoUnlock();
  }

  /**
   * Listens for the first tap/click/key and unlocks audio then. Safe to call
   * more than once. If start() is called before the user has interacted, the
   * alarm begins ringing as soon as this unlock happens.
   */
  armAutoUnlock(): void {
    if (typeof document === "undefined" || this.gesturesArmed) return;
    this.gesturesArmed = true;
    for (const type of GESTURE_EVENTS) {
      document.addEventListener(type, this.onGesture, { capture: true, passive: true });
    }
  }

  setVolume(volume: number): void {
    this.volume = clamp01(volume);
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.01);
    }
  }

  /** Start the ring tone. It repeats until stop() is called. */
  start(volume?: number): void {
    if (typeof window === "undefined") return;
    if (volume !== undefined) this.setVolume(volume);
    if (this.active) return;

    this.configureAudioSession();
    this.ensureContext();
    if (!this.ctx || !this.master) return; // Web Audio unsupported

    this.active = true;
    this.session = this.ctx.createGain();
    this.session.gain.value = 1;
    this.session.connect(this.master);
    this.nextRingTime = 0;

    this.resumeSilentElement();
    void this.ensureRunning(1000).then(() => this.tick());

    // If we can't play yet (no gesture so far), unlock on the next tap.
    if (!this.isUnlocked) this.armAutoUnlock();

    this.schedulerId = window.setInterval(this.tick, TICK_MS);
    this.tick();
  }

  stop(): void {
    this.active = false;

    if (this.schedulerId !== null) {
      window.clearInterval(this.schedulerId);
      this.schedulerId = null;
    }

    const ctx = this.ctx;
    const session = this.session;
    this.session = null;

    if (ctx && session) {
      // Short fade-out avoids a click, then cut every queued beep.
      const t = ctx.currentTime;
      session.gain.cancelScheduledValues(t);
      session.gain.setValueAtTime(session.gain.value, t);
      session.gain.linearRampToValueAtTime(0, t + 0.03);

      for (const osc of this.liveNodes) {
        try {
          osc.stop(t + 0.04);
        } catch {
          /* already stopped */
        }
      }
      window.setTimeout(() => session.disconnect(), 150);
    }
    this.liveNodes.clear();
  }

  /** Short confirmation blip, used for the "Test sound" button. */
  blip(): void {
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    void this.ensureRunning(1000);

    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const env = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(660, now);
    osc.frequency.exponentialRampToValueAtTime(990, now + 0.08);

    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(0.35, now + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

    osc.connect(env);
    env.connect(this.master); // doesn't touch the alarm's own gain
    osc.onended = () => {
      osc.disconnect();
      env.disconnect();
    };
    osc.start(now);
    osc.stop(now + 0.13);
  }

  /**
   * Keep the screen on (Screen Wake Lock API, iOS 16.4+ / Android / desktop).
   * Useful while the page is waiting for the alarm time, since a locked
   * iPhone suspends web audio.
   */
  async setKeepAwake(on: boolean): Promise<void> {
    this.wantAwake = on;
    if (on) await this.acquireWakeLock();
    else await this.releaseWakeLock();
  }

  /** Release everything. Call when the alarm UI is torn down. */
  dispose(): void {
    this.stop();
    this.disarmAutoUnlock();
    void this.releaseWakeLock();
    this.wantAwake = false;

    if (this.listenersBound && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
      window.removeEventListener("pageshow", this.onVisibility);
      this.listenersBound = false;
    }

    if (this.silentAudio) {
      this.silentAudio.pause();
      this.silentAudio.removeAttribute("src");
      this.silentAudio.load();
      this.silentAudio = null;
    }
    if (this.silentUrl) {
      URL.revokeObjectURL(this.silentUrl);
      this.silentUrl = null;
    }

    if (this.ctx) {
      this.ctx.onstatechange = null;
      void this.ctx.close().catch(() => undefined);
    }
    this.ctx = null;
    this.master = null;
    this.primed = false;
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  private ensureContext(): void {
    if (this.ctx || typeof window === "undefined") return;

    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;

    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = this.volume;

    // Gentle limiter so overlapping beeps at high volume don't clip.
    const compressor = ctx.createDynamicsCompressor();
    master.connect(compressor);
    compressor.connect(ctx.destination);

    ctx.onstatechange = () => {
      // iOS flips to "interrupted" on calls, Siri, lock, app switch, etc.
      if (ctx.state === "running") {
        this.disarmAutoUnlock();
        if (this.active) this.tick();
      } else if (this.active) {
        this.armAutoUnlock();
      }
    };

    this.ctx = ctx;
    this.master = master;

    if (!this.listenersBound) {
      document.addEventListener("visibilitychange", this.onVisibility);
      window.addEventListener("pageshow", this.onVisibility);
      this.listenersBound = true;
    }
  }

  /** Resumes the context if it is "suspended" or iOS's "interrupted". */
  private async ensureRunning(timeoutMs = 0): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;

    const state = ctx.state as string;
    if (state === "running" || state === "closed") return;

    this.lastResumeTry = Date.now();
    try {
      const resume = ctx.resume();
      // resume() can hang forever on iOS when it isn't allowed; don't wait on it.
      if (timeoutMs > 0) {
        await Promise.race([
          resume,
          new Promise<void>((resolve) => window.setTimeout(resolve, timeoutMs)),
        ]);
      } else {
        await resume;
      }
    } catch {
      /* ignore; we'll retry on the next gesture or tick */
    }
  }

  /** iOS 16.4+: mark audio as "playback" so the silent switch doesn't mute it. */
  private configureAudioSession(): void {
    if (typeof navigator === "undefined") return;
    const session = (navigator as AudioSessionNavigator).audioSession;
    if (session) {
      try {
        session.type = "playback";
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Older iOS (< 16.4) has no Audio Session API. Playing a looping silent
   * <audio> element switches Safari to the "playback" category, which makes
   * Web Audio ignore the silent switch. Must be started inside a user gesture.
   */
  private startSilentElementIfNeeded(): void {
    if (this.silentAudio || !isIOS()) return;
    if ((navigator as AudioSessionNavigator).audioSession) return; // not needed

    this.silentUrl = createSilentWavUrl();
    const el = new Audio(this.silentUrl);
    el.loop = true;
    el.preload = "auto";
    el.setAttribute("playsinline", "");
    this.silentAudio = el;
    void el.play().catch(() => undefined);
  }

  private resumeSilentElement(): void {
    if (this.silentAudio?.paused) {
      void this.silentAudio.play().catch(() => undefined);
    }
  }

  /** Plays one silent sample inside the gesture so iOS fully enables audio. */
  private playSilentBuffer(): void {
    if (this.primed || !this.ctx) return;
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = this.ctx.createBuffer(1, 1, 22050);
      src.connect(this.ctx.destination);
      src.start(0);
      this.primed = true;
    } catch {
      /* ignore */
    }
  }

  /** Schedules rings ahead of time on the audio clock. */
  private tick = (): void => {
    const ctx = this.ctx;
    if (!this.active || !ctx || !this.session) return;

    if (ctx.state !== "running") {
      // Retry periodically (works after an interruption ends, or if the
      // browser allows it); otherwise the next tap will unlock it.
      if (Date.now() - this.lastResumeTry > RESUME_RETRY_MS) void this.ensureRunning();
      return;
    }

    const now = ctx.currentTime;
    if (this.nextRingTime < now) this.nextRingTime = now + 0.05;

    while (this.nextRingTime < now + LOOKAHEAD) {
      this.scheduleRing(this.nextRingTime);
      this.nextRingTime += RING_PERIOD;
    }
  };

  private scheduleRing(start: number): void {
    const ctx = this.ctx;
    const bus = this.session;
    if (!ctx || !bus) return;

    RING_NOTES.forEach((freq, i) => {
      const t = start + i * NOTE_SPACING;
      const osc = ctx.createOscillator();
      const env = ctx.createGain();

      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, t);

      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.9, t + 0.02);
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.14);

      osc.connect(env);
      env.connect(bus);

      this.liveNodes.add(osc);
      osc.onended = () => {
        this.liveNodes.delete(osc);
        osc.disconnect();
        env.disconnect();
      };

      osc.start(t);
      osc.stop(t + 0.16);
    });
  }

  private onGesture = (): void => {
    void this.unlock();
  };

  private disarmAutoUnlock(): void {
    if (!this.gesturesArmed || typeof document === "undefined") return;
    this.gesturesArmed = false;
    for (const type of GESTURE_EVENTS) {
      document.removeEventListener(type, this.onGesture, { capture: true });
    }
  }

  private onVisibility = (): void => {
    if (typeof document === "undefined") return;

    if (document.visibilityState === "hidden") {
      this.wakeLock = null; // the browser releases it automatically
      return;
    }

    void this.ensureRunning();
    if (this.wantAwake) void this.acquireWakeLock();
    if (this.active) this.tick();
  };

  private async acquireWakeLock(): Promise<void> {
    if (typeof navigator === "undefined" || typeof document === "undefined") return;
    const nav = navigator as WakeLockNavigator;
    if (!nav.wakeLock || this.wakeLock || document.visibilityState !== "visible") return;
    try {
      this.wakeLock = await nav.wakeLock.request("screen");
    } catch {
      /* denied or unsupported */
    }
  }

  private async releaseWakeLock(): Promise<void> {
    const lock = this.wakeLock;
    this.wakeLock = null;
    if (lock) {
      try {
        await lock.release();
      } catch {
        /* ignore */
      }
    }
  }
}

export const alarm = new AlarmSound();