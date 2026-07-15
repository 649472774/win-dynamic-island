import { describe, expect, it, vi } from "vitest";
import {
  NOTICE_PRIORITY,
  NoticeRuntime,
  type NoticeInput,
  type SafePayload,
} from "./notices";

function notice(overrides: Partial<NoticeInput> = {}): NoticeInput {
  return {
    id: "bluetooth:headphones",
    source: "bluetooth",
    kind: "lifecycle",
    phase: "connected",
    priority: NOTICE_PRIORITY.lifecycle,
    ttlMs: 3_000,
    cooldownMs: 2_000,
    payload: { name: "Headphones" },
    ...overrides,
  };
}

describe("NoticeRuntime", () => {
  it("upserts a stable id and deduplicates identical updates", () => {
    let now = 100;
    const runtime = new NoticeRuntime(() => now);

    expect(runtime.upsert(notice())).toBe(true);
    expect(runtime.upsert(notice())).toBe(false);
    expect(runtime.getSnapshot().current?.createdAt).toBe(100);

    now = 200;
    expect(
      runtime.upsert(notice({ payload: { name: "Headphones", battery: 82 } })),
    ).toBe(true);
    expect(runtime.getSnapshot().current?.updatedAt).toBe(200);
    expect(runtime.getSnapshot().pending).toEqual([]);
  });

  it("refreshes a visible HUD lifetime only when requested", () => {
    let now = 0;
    const runtime = new NoticeRuntime(() => now);
    const volume = notice({
      id: "hud:volume",
      source: "volume",
      kind: "hud",
      phase: "updated",
      priority: NOTICE_PRIORITY.hud,
      ttlMs: 1_600,
      refreshTtl: true,
      payload: { kind: "volume" },
    });

    runtime.upsert(volume);
    now = 1_200;
    expect(runtime.upsert(volume)).toBe(true);
    now = 2_799;
    runtime.tick();
    expect(runtime.getSnapshot().current?.id).toBe("hud:volume");
    now = 2_800;
    runtime.tick();
    expect(runtime.getSnapshot().current).toBeNull();
  });

  it("starts a changed visible upsert with a fresh TTL", () => {
    let now = 0;
    const runtime = new NoticeRuntime(() => now);
    runtime.upsert(notice({ ttlMs: 1_000 }));

    now = 900;
    runtime.upsert(notice({ ttlMs: 1_000, payload: { battery: 70 } }));
    now = 1_899;
    runtime.tick();
    expect(runtime.getSnapshot().current).not.toBeNull();
    now = 1_900;
    runtime.tick();
    expect(runtime.getSnapshot().current).toBeNull();
  });

  it("preempts by priority and restores the paused notice TTL", () => {
    let now = 0;
    const runtime = new NoticeRuntime(() => now);
    runtime.upsert(
      notice({
        id: "hud:volume",
        source: "volume",
        kind: "hud",
        phase: "updated",
        priority: NOTICE_PRIORITY.hud,
        ttlMs: 1_600,
      }),
    );

    now = 600;
    runtime.upsert(
      notice({
        id: "bluetooth:low",
        kind: "alert",
        phase: "low-battery",
        priority: NOTICE_PRIORITY.urgent,
        ttlMs: 500,
      }),
    );
    expect(runtime.getSnapshot().current?.id).toBe("bluetooth:low");
    expect(runtime.getSnapshot().pending[0]?.id).toBe("hud:volume");

    now = 1_100;
    runtime.tick();
    expect(runtime.getSnapshot().current?.id).toBe("hud:volume");

    now = 2_099;
    runtime.tick();
    expect(runtime.getSnapshot().current?.id).toBe("hud:volume");
    now = 2_101;
    runtime.tick();
    expect(runtime.getSnapshot().current).toBeNull();
  });

  it("expires, supports manual dismissal, and applies cooldown", () => {
    let now = 0;
    const runtime = new NoticeRuntime(() => now);
    runtime.upsert(notice({ ttlMs: 200 }));

    now = 200;
    runtime.tick();
    expect(runtime.getSnapshot().current).toBeNull();
    expect(runtime.upsert(notice({ ttlMs: 200 }))).toBe(false);

    now = 2_201;
    expect(runtime.upsert(notice({ ttlMs: 200 }))).toBe(true);
    expect(runtime.dismiss("bluetooth:headphones")).toBe(true);
    expect(runtime.dismiss("bluetooth:headphones")).toBe(false);
  });

  it("keeps local dismissal separate from source removal", () => {
    let now = 0;
    const runtime = new NoticeRuntime(() => now);
    const input = notice({ cooldownMs: 1_000 });
    runtime.upsert(input);

    expect(runtime.dismissLocal(input)).toBe(true);
    expect(runtime.upsert(input)).toBe(false);

    now = 1_001;
    expect(runtime.upsert(input)).toBe(true);
    expect(runtime.sourceRemoved(input)).toBe(true);
    expect(runtime.upsert(input)).toBe(true);
  });

  it("isolates identical public ids by source and kind", () => {
    const runtime = new NoticeRuntime(() => 0);
    runtime.upsert(notice({ id: "opaque-id" }));
    runtime.upsert(
      notice({
        id: "opaque-id",
        source: "notification-mirror",
        kind: "status",
        phase: "added",
        priority: NOTICE_PRIORITY.informational,
      }),
    );

    expect(runtime.getSnapshot().current?.source).toBe("bluetooth");
    expect(runtime.getSnapshot().pending[0]?.source).toBe(
      "notification-mirror",
    );
    expect(
      runtime.sourceRemoved({
        id: "opaque-id",
        source: "notification-mirror",
        kind: "status",
      }),
    ).toBe(true);
    expect(runtime.getSnapshot().current?.source).toBe("bluetooth");
  });

  it("rejects non-JSON, cyclic, and unbounded payloads", () => {
    const runtime = new NoticeRuntime(() => 0);
    expect(() =>
      runtime.upsert(notice({ payload: { invalid: Number.NaN } })),
    ).toThrow("bounded JSON-safe");
    expect(() =>
      runtime.upsert(notice({ payload: { invalid: new Date() } as never })),
    ).toThrow("bounded JSON-safe");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      runtime.upsert(notice({ payload: cyclic as never })),
    ).toThrow("bounded JSON-safe");
    expect(() =>
      runtime.upsert(notice({ cooldownMs: Number.POSITIVE_INFINITY })),
    ).toThrow("cooldownMs");
    let getterReads = 0;
    const accessorPayload: SafePayload = {};
    Object.defineProperty(accessorPayload, "value", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return "stateful";
      },
    });
    expect(() =>
      runtime.upsert(notice({ payload: accessorPayload })),
    ).toThrow("bounded JSON-safe");
    expect(getterReads).toBe(0);
    const nullPayload = notice();
    Object.defineProperty(nullPayload, "payload", { value: null });
    expect(() => runtime.upsert(nullPayload)).toThrow("bounded JSON-safe");
  });

  it("retains an immutable bounded copy of provider payloads", () => {
    const runtime = new NoticeRuntime(() => 0);
    const payload: SafePayload = {
      nested: { name: "Private alias" },
      flags: ["audio"],
    };
    runtime.upsert(notice({ payload }));

    payload.nested = { name: "mutated" };
    payload.flags = [];
    expect(runtime.getSnapshot().current?.payload).toEqual({
      nested: { name: "Private alias" },
      flags: ["audio"],
    });
    expect(() => {
      Object.assign(runtime.getSnapshot().current!.payload, {
        extra: "unsafe",
      });
    }).toThrow();

    const prototypePayload: SafePayload = Object.create(null);
    prototypePayload.__proto__ = { safe: true };
    runtime.upsert(notice({ payload: prototypePayload }));
    const cloned = runtime.getSnapshot().current!.payload;
    expect(Object.prototype.hasOwnProperty.call(cloned, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(cloned)).toBeNull();
  });

  it("enforces deterministic source and global capacity with eviction reasons", () => {
    const runtime = new NoticeRuntime(
      () => 10,
      { global: 2, perSource: 1 },
    );
    const evictions: string[] = [];
    runtime.subscribeEvictions((eviction) => {
      evictions.push(`${eviction.reason}:${eviction.event.id}`);
    });

    runtime.upsert(
      notice({
        id: "bluetooth:first",
        priority: NOTICE_PRIORITY.lifecycle,
      }),
    );
    expect(
      runtime.upsert(
        notice({
          id: "bluetooth:second",
          priority: NOTICE_PRIORITY.informational,
        }),
      ),
    ).toBe(false);
    runtime.upsert(
      notice({
        id: "calendar:first",
        source: "calendar",
        phase: "startingSoon",
        priority: NOTICE_PRIORITY.informational,
      }),
    );
    runtime.upsert(
      notice({
        id: "mirror:first",
        source: "notification-mirror",
        kind: "status",
        phase: "added",
        priority: NOTICE_PRIORITY.informational,
      }),
    );

    expect(evictions).toEqual([
      "source-capacity:bluetooth:second",
      "global-capacity:mirror:first",
    ]);
    expect(runtime.getSnapshot().current?.id).toBe("bluetooth:first");
    expect(runtime.getSnapshot().pending.map((event) => event.id)).toEqual([
      "calendar:first",
    ]);
  });

  it("expires current work before reducing source capacity", () => {
    let now = 0;
    const runtime = new NoticeRuntime(() => now, {
      global: 4,
      perSource: 4,
    });
    runtime.upsert(notice({ id: "current", ttlMs: 100 }));
    runtime.upsert(
      notice({
        id: "pending",
        priority: NOTICE_PRIORITY.informational,
      }),
    );

    now = 100;
    runtime.setSourceCapacity("bluetooth", 1);
    expect(runtime.getSnapshot().current?.id).toBe("pending");
    expect(runtime.getSnapshot().pending).toEqual([]);
  });

  it("isolates throwing observers while completing capacity transitions", () => {
    const runtime = new NoticeRuntime(() => 0, {
      global: 1,
      perSource: 1,
    });
    const snapshots: string[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("diagnostic hook failure");
    });
    runtime.subscribeEvictions(() => {
      throw new Error("observer failure");
    });
    runtime.subscribe(() => {
      throw new Error("observer failure");
    });
    runtime.subscribe((snapshot) => {
      snapshots.push(snapshot.current?.id ?? "empty");
    });

    runtime.upsert(notice({ id: "first" }));
    expect(
      runtime.upsert(
        notice({
          id: "second",
          priority: NOTICE_PRIORITY.urgent,
        }),
      ),
    ).toBe(false);
    expect(runtime.getSnapshot().current?.id).toBe("first");
    expect(snapshots).toEqual(["first", "first"]);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("publishes once to a listener that resubscribes itself", () => {
    const runtime = new NoticeRuntime(() => 0);
    let calls = 0;
    let unsubscribe = () => {};
    const listener = () => {
      calls += 1;
      unsubscribe();
      unsubscribe = runtime.subscribe(listener);
    };
    unsubscribe = runtime.subscribe(listener);

    runtime.upsert(notice());
    expect(calls).toBe(1);
    unsubscribe();
  });

  it("restores pending work when expiry precedes an early upsert return", () => {
    let now = 0;
    const runtime = new NoticeRuntime(() => now);
    const volume = notice({
      id: "hud:volume",
      source: "volume",
      kind: "hud",
      phase: "updated",
      priority: NOTICE_PRIORITY.hud,
      ttlMs: 1_000,
      refreshTtl: true,
    });
    runtime.upsert(volume);
    runtime.upsert(
      notice({
        id: "bluetooth:low",
        kind: "alert",
        phase: "low-battery",
        priority: NOTICE_PRIORITY.urgent,
        ttlMs: 100,
        cooldownMs: 1_000,
      }),
    );

    now = 100;
    expect(runtime.upsert(volume)).toBe(true);
    expect(runtime.getSnapshot().current?.id).toBe("hud:volume");

    runtime.upsert(
      notice({
        id: "bluetooth:low",
        kind: "alert",
        phase: "low-battery",
        priority: NOTICE_PRIORITY.urgent,
        ttlMs: 100,
        cooldownMs: 1_000,
      }),
    );
    expect(runtime.getSnapshot().current?.id).toBe("hud:volume");
  });

  it("produces a JSON-serializable public snapshot", () => {
    const runtime = new NoticeRuntime(() => 42);
    runtime.upsert(
      notice({
        payload: {
          name: "Private alias",
          battery: null,
          flags: ["audio", true],
        },
      }),
    );

    expect(() => JSON.stringify(runtime.getSnapshot())).not.toThrow();
    expect(JSON.parse(JSON.stringify(runtime.getSnapshot())).current.id).toBe(
      "bluetooth:headphones",
    );
  });

  it("accepts provider-owned lifecycle phases through semantic bands", () => {
    const runtime = new NoticeRuntime(() => 42);
    type CalendarPhase = "scheduled" | "startingSoon" | "cancelled";
    type CalendarPayload = SafePayload & {
      lifecyclePhase: CalendarPhase;
      basis: "calendarTime" | "providerConfirmed";
      confidence: "low" | "medium" | "high";
    };
    const meetingNotice: NoticeInput<CalendarPhase, CalendarPayload> = {
      id: "m8:calendar:event",
      source: "calendar",
      kind: "lifecycle",
      phase: "startingSoon",
      priority: NOTICE_PRIORITY.informational,
      ttlMs: 6_000,
      payload: {
        lifecyclePhase: "startingSoon",
        basis: "calendarTime",
        confidence: "high",
      },
    };
    runtime.upsert(meetingNotice);

    expect(runtime.getSnapshot().current).toMatchObject({
      source: "calendar",
      kind: "lifecycle",
      phase: "startingSoon",
      priority: NOTICE_PRIORITY.informational,
    });
  });
});
