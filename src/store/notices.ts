import { create } from "zustand";

/** Providers own their phase vocabulary; the runtime treats it as opaque data. */
export type NoticePhase = string;

/** Provider-neutral presentation intent used for queue policy and dispatch. */
export type NoticeKind =
  | "hud"
  | "status"
  | "lifecycle"
  | "alert"
  | "service";

/**
 * Shared preemption bands. New providers must select a semantic band instead of
 * inventing raw numbers, keeping cross-provider behavior predictable.
 */
export const NOTICE_PRIORITY = {
  hud: 20,
  informational: 50,
  lifecycle: 60,
  timeSensitive: 65,
  service: 70,
  urgent: 80,
} as const;

export type NoticePriority =
  (typeof NOTICE_PRIORITY)[keyof typeof NOTICE_PRIORITY];

export type SafeValue =
  | string
  | number
  | boolean
  | null
  | SafeValue[]
  | { [key: string]: SafeValue };

export type SafePayload = Record<string, SafeValue>;

export interface NoticeEvent {
  readonly id: string;
  readonly source: string;
  readonly kind: NoticeKind;
  readonly phase: NoticePhase;
  readonly priority: NoticePriority;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number | null;
  readonly ttlMs: number;
  readonly cooldownMs: number;
  readonly payload: Readonly<Record<string, SafeValue>>;
}

export type NoticeIdentity = Pick<NoticeEvent, "id" | "source" | "kind">;
export type NoticeSelector = string | NoticeIdentity;

/**
 * Providers may bind their own closed phase and payload types while the runtime
 * stores the provider-neutral serializable envelope.
 */
export interface NoticeInput<
  TPhase extends string = NoticePhase,
  TPayload extends SafePayload = SafePayload,
> {
  id: string;
  source: string;
  kind: NoticeKind;
  phase: TPhase;
  priority: NoticePriority;
  ttlMs: number;
  /** Refresh an identical visible notice instead of treating it as a no-op. */
  refreshTtl?: boolean;
  cooldownMs?: number;
  payload?: TPayload;
}

export interface NoticeSnapshot {
  readonly current: NoticeEvent | null;
  readonly pending: readonly NoticeEvent[];
}

export interface NoticeCapacity {
  global: number;
  perSource: number;
}

export const DEFAULT_NOTICE_CAPACITY: NoticeCapacity = {
  global: 32,
  perSource: 8,
};

export type NoticeEvictionReason = "global-capacity" | "source-capacity";

export interface NoticeEviction {
  readonly event: NoticeEvent;
  readonly reason: NoticeEvictionReason;
  readonly at: number;
}

interface Entry {
  event: NoticeEvent;
  remainingMs: number;
  visibleSince: number | null;
  sequence: number;
  fingerprint: string;
}

interface Cooldown {
  until: number;
  priority: number;
}

const EMPTY_SNAPSHOT: NoticeSnapshot = Object.freeze({
  current: null,
  pending: Object.freeze([]),
});
const MAX_SAFE_PAYLOAD_DEPTH = 8;
const MAX_SAFE_PAYLOAD_VALUES = 2_048;
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
const MAX_COOLDOWN_ENTRIES = 256;

function fingerprint(input: NoticeInput, payload: SafePayload): string {
  return JSON.stringify([
    input.source,
    input.kind,
    input.phase,
    input.priority,
    payload,
  ]);
}

function entryKey(value: NoticeIdentity): string {
  return [value.source, value.kind, value.id].join("\u0000");
}

function cooldownKey(
  event: Pick<NoticeEvent, "id" | "source" | "kind" | "phase">,
): string {
  return [entryKey(event), event.phase].join("\u0000");
}

function cloneSafePayload(value: unknown): SafePayload {
  const seen = new WeakSet<object>();
  let values = 0;
  const invalid = (): never => {
    throw new Error("Notice payload must be a bounded JSON-safe object");
  };
  const visit = (candidate: unknown, depth: number): SafeValue => {
    values += 1;
    if (values > MAX_SAFE_PAYLOAD_VALUES || depth > MAX_SAFE_PAYLOAD_DEPTH) {
      return invalid();
    }
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) {
      return candidate;
    }
    if (typeof candidate === "number") {
      return Number.isFinite(candidate) ? candidate : invalid();
    }
    if (typeof candidate !== "object" || seen.has(candidate)) return invalid();
    const isArray = Array.isArray(candidate);
    const prototype = Object.getPrototypeOf(candidate);
    if (!isArray && prototype !== Object.prototype && prototype !== null) {
      return invalid();
    }
    const keys = Reflect.ownKeys(candidate);
    if (
      keys.some((key) => typeof key === "symbol") ||
      values + keys.length > MAX_SAFE_PAYLOAD_VALUES
    ) {
      return invalid();
    }

    seen.add(candidate);
    let clone: SafeValue;
    if (isArray) {
      if (
        candidate.length > MAX_SAFE_PAYLOAD_VALUES ||
        keys.length !== candidate.length + 1 ||
        !keys.includes("length")
      ) {
        return invalid();
      }
      const keySet = new Set(keys);
      const arrayClone: SafeValue[] = [];
      for (let index = 0; index < candidate.length; index += 1) {
        const key = String(index);
        if (!keySet.has(key)) return invalid();
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (
          !descriptor ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          return invalid();
        }
        arrayClone.push(visit(descriptor.value, depth + 1));
      }
      Object.freeze(arrayClone);
      clone = arrayClone;
    } else {
      const objectClone: SafePayload = Object.create(null);
      for (const key of keys) {
        if (typeof key !== "string") return invalid();
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (
          !descriptor ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          return invalid();
        }
        objectClone[key] = visit(descriptor.value, depth + 1);
      }
      Object.freeze(objectClone);
      clone = objectClone;
    }
    seen.delete(candidate);
    return clone;
  };

  const clone = visit(value, 0);
  if (clone === null || typeof clone !== "object" || Array.isArray(clone)) {
    return invalid();
  }
  return clone;
}

function asPublic(entry: Entry): NoticeEvent {
  return Object.freeze({
    ...entry.event,
    expiresAt:
      entry.visibleSince === null
        ? null
        : entry.visibleSince + Math.max(0, entry.remainingMs),
  });
}

/**
 * Deterministic, in-memory transient notice queue. TTL only advances while a
 * notice is visible, so a preempted HUD can resume for its remaining lifetime.
 */
export class NoticeRuntime {
  private entries = new Map<string, Entry>();
  private cooldowns = new Map<string, Cooldown>();
  private currentKey: string | null = null;
  private sequence = 0;
  private listeners = new Set<(snapshot: NoticeSnapshot) => void>();
  private evictionListeners = new Set<(eviction: NoticeEviction) => void>();
  private sourceCapacities = new Map<string, number>();
  private snapshot: NoticeSnapshot = EMPTY_SNAPSHOT;
  private readonly capacity: NoticeCapacity;

  constructor(
    private readonly now: () => number = Date.now,
    capacity: Partial<NoticeCapacity> = {},
  ) {
    this.capacity = {
      global: this.validateCapacity(
        capacity.global ?? DEFAULT_NOTICE_CAPACITY.global,
      ),
      perSource: this.validateCapacity(
        capacity.perSource ?? DEFAULT_NOTICE_CAPACITY.perSource,
      ),
    };
  }

  getSnapshot(): NoticeSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: NoticeSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeEvictions(listener: (eviction: NoticeEviction) => void): () => void {
    this.evictionListeners.add(listener);
    return () => this.evictionListeners.delete(listener);
  }

  setSourceCapacity(source: string, capacity: number): void {
    if (!source.trim()) throw new Error("Notice source must be non-empty");
    this.sourceCapacities.set(source, this.validateCapacity(capacity));
    const now = this.now();
    this.tickInternal(now);
    this.enforceCapacity(source, now);
    this.reselect(now);
    this.publish();
  }

  upsert(input: NoticeInput): boolean {
    if (!input.id.trim() || !input.source.trim()) {
      throw new Error("Notice id and source must be non-empty");
    }
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
      throw new Error("Notice ttlMs must be positive");
    }
    if (!Number.isFinite(input.priority)) {
      throw new Error("Notice priority must be finite");
    }
    const cooldownMs = input.cooldownMs ?? 0;
    if (
      !Number.isFinite(cooldownMs) ||
      cooldownMs < 0 ||
      cooldownMs > MAX_COOLDOWN_MS
    ) {
      throw new Error(
        `Notice cooldownMs must be between 0 and ${MAX_COOLDOWN_MS}`,
      );
    }
    const payload = cloneSafePayload(
      input.payload === undefined ? {} : input.payload,
    );

    const now = this.now();
    const expiredCurrent = this.tickInternal(now);
    const nextFingerprint = fingerprint(input, payload);
    const key = entryKey(input);
    const existing = this.entries.get(key);

    if (!existing) {
      const cooling = this.cooldowns.get(
        cooldownKey(input),
      );
      if (cooling && cooling.until > now && input.priority <= cooling.priority) {
        if (expiredCurrent) {
          this.reselect(now);
          this.publish();
        }
        return false;
      }
    }

    if (existing?.fingerprint === nextFingerprint) {
      if (!input.refreshTtl) {
        if (expiredCurrent) {
          this.reselect(now);
          this.publish();
        }
        return false;
      }
      existing.event = {
        ...existing.event,
        updatedAt: now,
        ttlMs: input.ttlMs,
      };
      existing.remainingMs = input.ttlMs;
      if (existing.visibleSince !== null) existing.visibleSince = now;
      this.reselect(now);
      this.publish();
      return true;
    }

    const createdAt = existing?.event.createdAt ?? now;
    const event: NoticeEvent = {
      id: input.id,
      source: input.source,
      kind: input.kind,
      phase: input.phase,
      priority: input.priority,
      createdAt,
      updatedAt: now,
      expiresAt: null,
      ttlMs: input.ttlMs,
      cooldownMs,
      payload,
    };
    const entry: Entry = {
      event,
      remainingMs: input.ttlMs,
      visibleSince: existing?.visibleSince == null ? null : now,
      sequence: existing?.sequence ?? this.sequence++,
      fingerprint: nextFingerprint,
    };
    this.entries.set(key, entry);
    this.enforceCapacity(input.source, now);
    this.reselect(now);
    this.publish();
    return this.entries.has(key);
  }

  dismissLocal(selector: NoticeSelector): boolean {
    const now = this.now();
    const expiredCurrent = this.tickInternal(now);
    const keys = this.resolveKeys(selector);
    let removed = false;
    for (const key of keys) {
      removed = this.remove(key, now, true) || removed;
    }
    if (!removed && !expiredCurrent) return false;
    this.reselect(now);
    this.publish();
    return removed;
  }

  sourceRemoved(identity: NoticeIdentity): boolean {
    const now = this.now();
    const expiredCurrent = this.tickInternal(now);
    const removed = this.remove(entryKey(identity), now, false);
    if (!removed && !expiredCurrent) return false;
    this.reselect(now);
    this.publish();
    return removed;
  }

  /** Compatibility alias for existing local-dismiss callers. */
  dismiss(selector: NoticeSelector): boolean {
    return this.dismissLocal(selector);
  }

  tick(): void {
    const now = this.now();
    if (!this.tickInternal(now)) return;
    this.reselect(now);
    this.publish();
  }

  nextExpiryDelay(): number | null {
    const current = this.currentKey
      ? this.entries.get(this.currentKey)
      : undefined;
    if (!current || current.visibleSince === null) return null;
    const elapsed = this.now() - current.visibleSince;
    return Math.max(0, current.remainingMs - elapsed);
  }

  clear(): void {
    this.entries.clear();
    this.cooldowns.clear();
    this.currentKey = null;
    this.snapshot = EMPTY_SNAPSHOT;
    this.publish();
  }

  private tickInternal(now: number): boolean {
    for (const [key, value] of this.cooldowns) {
      if (value.until <= now) this.cooldowns.delete(key);
    }
    if (!this.currentKey) return false;
    const current = this.entries.get(this.currentKey);
    if (!current || current.visibleSince === null) return false;
    const elapsed = Math.max(0, now - current.visibleSince);
    if (elapsed < current.remainingMs) return false;
    this.remove(this.currentKey, now, true);
    return true;
  }

  private resolveKeys(selector: NoticeSelector): string[] {
    if (typeof selector !== "string") return [entryKey(selector)];
    return [...this.entries]
      .filter(([, entry]) => entry.event.id === selector)
      .map(([key]) => key);
  }

  private remove(key: string, now: number, applyCooldown: boolean): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (applyCooldown && entry.event.cooldownMs > 0) {
      this.cooldowns.set(cooldownKey(entry.event), {
        until: now + entry.event.cooldownMs,
        priority: entry.event.priority,
      });
      this.enforceCooldownCapacity();
    }
    this.entries.delete(key);
    if (this.currentKey === key) this.currentKey = null;
    return true;
  }

  private validateCapacity(value: number): number {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error("Notice capacity must be a positive integer");
    }
    return value;
  }

  private enforceCooldownCapacity(): void {
    while (this.cooldowns.size > MAX_COOLDOWN_ENTRIES) {
      const oldest = [...this.cooldowns.entries()].sort(
        ([aKey, a], [bKey, b]) =>
          a.until - b.until ||
          a.priority - b.priority ||
          aKey.localeCompare(bKey),
      )[0];
      if (!oldest) return;
      this.cooldowns.delete(oldest[0]);
    }
  }

  private enforceCapacity(source: string, now: number): void {
    const sourceLimit =
      this.sourceCapacities.get(source) ?? this.capacity.perSource;
    while (
      [...this.entries.values()].filter(
        (entry) => entry.event.source === source,
      ).length > sourceLimit
    ) {
      this.evictOne(
        [...this.entries.entries()].filter(
          ([, entry]) => entry.event.source === source,
        ),
        "source-capacity",
        now,
      );
    }
    while (this.entries.size > this.capacity.global) {
      this.evictOne(
        [...this.entries.entries()],
        "global-capacity",
        now,
      );
    }
  }

  private evictOne(
    candidates: [string, Entry][],
    reason: NoticeEvictionReason,
    now: number,
  ): void {
    const victim = candidates.sort(
      ([aKey, a], [bKey, b]) =>
        Number(aKey === this.currentKey) - Number(bKey === this.currentKey) ||
        a.event.priority - b.event.priority ||
        b.sequence - a.sequence,
    )[0];
    if (!victim) return;
    const [key, entry] = victim;
    this.remove(key, now, false);
    const eviction: NoticeEviction = Object.freeze({
      event: asPublic(entry),
      reason,
      at: now,
    });
    this.notifySafely(this.evictionListeners, eviction, "eviction");
  }

  private reselect(now: number): void {
    const next =
      [...this.entries.values()].sort(
        (a, b) =>
          b.event.priority - a.event.priority ||
          a.sequence - b.sequence ||
          b.event.updatedAt - a.event.updatedAt,
      )[0] ?? null;
    const nextKey = next ? entryKey(next.event) : null;

    if (nextKey !== this.currentKey && this.currentKey) {
      const previous = this.entries.get(this.currentKey);
      if (previous?.visibleSince !== null && previous) {
        previous.remainingMs = Math.max(
          0,
          previous.remainingMs - (now - previous.visibleSince),
        );
        previous.visibleSince = null;
      }
    }

    this.currentKey = nextKey;
    if (next && next.visibleSince === null) next.visibleSince = now;
  }

  private publish(): void {
    const current = this.currentKey
      ? this.entries.get(this.currentKey)
      : undefined;
    const pending = [...this.entries.values()]
      .filter((entry) => entryKey(entry.event) !== this.currentKey)
      .sort(
        (a, b) =>
          b.event.priority - a.event.priority || a.sequence - b.sequence,
      )
      .map(asPublic);
    Object.freeze(pending);
    this.snapshot = Object.freeze({
      current: current ? asPublic(current) : null,
      pending,
    });
    this.notifySafely(this.listeners, this.snapshot, "snapshot");
  }

  private notifySafely<T>(
    listeners: Set<(value: T) => void>,
    value: T,
    channel: string,
  ): void {
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch (error) {
        try {
          console.error(`Notice runtime ${channel} listener failed`, error);
        } catch {
          // Diagnostic hooks must not compromise queue completion.
        }
      }
    }
  }
}

interface NoticeGlobal {
  __winDynamicIslandNoticeRuntimeV2?: NoticeRuntime;
  __winDynamicIslandNoticeTimerV2?: number | null;
}

const noticeGlobal = globalThis as typeof globalThis & NoticeGlobal;
export const noticeRuntime =
  noticeGlobal.__winDynamicIslandNoticeRuntimeV2 ?? new NoticeRuntime();
noticeGlobal.__winDynamicIslandNoticeRuntimeV2 = noticeRuntime;

interface NoticeStore extends NoticeSnapshot {
  publish: (input: NoticeInput) => boolean;
  dismissLocal: (selector: NoticeSelector) => boolean;
  sourceRemoved: (identity: NoticeIdentity) => boolean;
}

function scheduleExpiry(): void {
  if (noticeGlobal.__winDynamicIslandNoticeTimerV2 != null) {
    window.clearTimeout(noticeGlobal.__winDynamicIslandNoticeTimerV2);
  }
  const delay = noticeRuntime.nextExpiryDelay();
  noticeGlobal.__winDynamicIslandNoticeTimerV2 =
    delay === null
      ? null
      : window.setTimeout(() => {
          noticeGlobal.__winDynamicIslandNoticeTimerV2 = null;
          noticeRuntime.tick();
          scheduleExpiry();
        }, delay + 1);
}

export const useNotices = create<NoticeStore>((set) => {
  noticeRuntime.subscribe((snapshot) => set(snapshot));
  return {
    ...noticeRuntime.getSnapshot(),
    publish: (input) => {
      const changed = noticeRuntime.upsert(input);
      scheduleExpiry();
      return changed;
    },
    dismissLocal: (selector) => {
      const changed = noticeRuntime.dismissLocal(selector);
      scheduleExpiry();
      return changed;
    },
    sourceRemoved: (identity) => {
      const changed = noticeRuntime.sourceRemoved(identity);
      scheduleExpiry();
      return changed;
    },
  };
});

export function publishNotice(input: NoticeInput): boolean {
  return useNotices.getState().publish(input);
}

export function dismissNotice(selector: NoticeSelector): boolean {
  return useNotices.getState().dismissLocal(selector);
}

export function sourceRemovedNotice(identity: NoticeIdentity): boolean {
  return useNotices.getState().sourceRemoved(identity);
}

export function setNoticeSourceCapacity(
  source: string,
  capacity: number,
): void {
  noticeRuntime.setSourceCapacity(source, capacity);
  scheduleExpiry();
}

export function onNoticeEvicted(
  listener: (eviction: NoticeEviction) => void,
): () => void {
  return noticeRuntime.subscribeEvictions(listener);
}
