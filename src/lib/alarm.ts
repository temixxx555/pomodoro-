/**
 * Alarm that generates its own ring tone with the Web Audio API.
 *
 * No audio files, no network requests, no CORS problems — it works offline
 * and keeps looping until stop() is called.
 */
class AlarmSound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private loopId: number | null = null;
  private active = false;
  private volume = 0.6;

  /** Must be called from a user gesture (click/keypress) to satisfy autoplay rules. */
  async unlock(): Promise<void> {
    if (typeof window === "undefined") return;

    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return;

      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }

    if (this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch {
        /* ignore */
      }
    }
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.master && this.ctx && !this.active) {
      this.master.gain.setValueAtTime(this.volume, this.ctx.currentTime);
    }
  }

  /** Start the ring tone. It repeats until stop() is called. */
  start(volume?: number): void {
    if (volume !== undefined) {
      this.volume = Math.min(1, Math.max(0, volume));
    }
    if (!this.ctx || !this.master) return;

    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }

    this.active = true;
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setValueAtTime(this.volume, this.ctx.currentTime);

    const ring = () => {
      if (!this.active || !this.ctx || !this.master) return;

      const now = this.ctx.currentTime;
      // A classic two-tone "ring ring" pattern.
      const notes = [880, 1174.66, 880, 1174.66];

      notes.forEach((freq, i) => {
        const t = now + i * 0.16;
        const osc = this.ctx!.createOscillator();
        const env = this.ctx!.createGain();

        osc.type = "triangle";
        osc.frequency.setValueAtTime(freq, t);

        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(0.9, t + 0.02);
        env.gain.exponentialRampToValueAtTime(0.001, t + 0.14);

        osc.connect(env);
        env.connect(this.master!);
        osc.start(t);
        osc.stop(t + 0.16);
      });

      // Pause between rings, then repeat forever.
      this.loopId = window.setTimeout(ring, 1400);
    };

    ring();
  }

  stop(): void {
    this.active = false;

    if (this.loopId !== null) {
      window.clearTimeout(this.loopId);
      this.loopId = null;
    }

    // Cut off any ring that is still sounding right now.
    if (this.master && this.ctx) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setValueAtTime(0, this.ctx.currentTime);
    }
  }

  /** Short confirmation blip, used for the "Test sound" button. */
  blip(): void {
    if (!this.ctx || !this.master) return;

    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }

    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.volume, now);

    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(660, now);
    osc.frequency.exponentialRampToValueAtTime(990, now + 0.08);

    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(0.35, now + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

    osc.connect(env);
    env.connect(this.master);
    osc.start(now);
    osc.stop(now + 0.13);
  }
}

export const alarm = new AlarmSound();
