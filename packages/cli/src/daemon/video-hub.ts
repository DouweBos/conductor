/**
 * Fan-out hub for a single device's H.264 stream: one capture, N subscribers.
 *
 * Mirrors Argus's videoForward.ts. The last-seen config and the last keyframe
 * access unit are cached so a late subscriber can configure its decoder and
 * start rendering immediately, without waiting for the next natural keyframe.
 */

import type { VideoConfig } from './video-protocol.js';

export interface VideoListener {
  onConfig: (config: VideoConfig) => void;
  onFrame: (annexB: Buffer, keyFrame: boolean) => void;
}

export class VideoHub {
  private readonly listeners = new Set<VideoListener>();
  private lastConfig: VideoConfig | null = null;
  private lastKeyframe: Buffer | null = null;

  get subscriberCount(): number {
    return this.listeners.size;
  }

  /**
   * Subscribe. If a config (and keyframe) are already cached they are delivered
   * synchronously so the decoder starts without waiting. Returns an unsubscribe.
   */
  subscribe(listener: VideoListener): () => void {
    this.listeners.add(listener);
    if (this.lastConfig) {
      listener.onConfig(this.lastConfig);
      if (this.lastKeyframe) listener.onFrame(this.lastKeyframe, true);
    }
    return () => this.listeners.delete(listener);
  }

  emitConfig(config: VideoConfig): void {
    this.lastConfig = config;
    // A config change invalidates the cached keyframe (dimensions may differ).
    this.lastKeyframe = null;
    for (const l of this.listeners) l.onConfig(config);
  }

  emitFrame(annexB: Buffer, keyFrame: boolean): void {
    if (keyFrame) this.lastKeyframe = annexB;
    for (const l of this.listeners) l.onFrame(annexB, keyFrame);
  }

  /** Current coded dimensions, if known. */
  dims(): { width: number; height: number } | null {
    return this.lastConfig
      ? { width: this.lastConfig.width, height: this.lastConfig.height }
      : null;
  }

  /** Drop cached state when capture ends. */
  clear(): void {
    this.lastConfig = null;
    this.lastKeyframe = null;
  }
}
