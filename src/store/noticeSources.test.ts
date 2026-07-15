import { describe, expect, it, vi } from "vitest";
import {
  NoticeSourceController,
  registerNoticeSource,
  type NativeNoticeSource,
  type NoticeSourceCapability,
} from "./noticeSources";

type TestState = "available" | "stopped" | "error";
type TestCapability = NoticeSourceCapability<TestState>;

function capability(state: TestState): TestCapability {
  return {
    state,
    observedAtMs: 1,
    recoverable: state === "error",
    reason: state === "error" ? "test failure" : null,
  };
}

function isTestCapability(value: unknown): value is TestCapability {
  if (value === null || typeof value !== "object") return false;
  const state = Reflect.get(value, "state");
  const observedAtMs = Reflect.get(value, "observedAtMs");
  const recoverable = Reflect.get(value, "recoverable");
  const reason = Reflect.get(value, "reason");
  return (
    (state === "available" || state === "stopped" || state === "error") &&
    typeof observedAtMs === "number" &&
    Number.isFinite(observedAtMs) &&
    typeof recoverable === "boolean" &&
    (typeof reason === "string" || reason === null)
  );
}

function source(
  name: string,
  start: NativeNoticeSource<TestCapability>["start"] = vi.fn(
    async () => capability("available"),
  ),
): NativeNoticeSource<TestCapability> {
  return {
    source: name,
    start,
    stop: vi.fn(async () => capability("stopped")),
    reconcile: vi.fn(async () => capability("available")),
    getCapability: vi.fn(async () => capability("available")),
    isCapability: isTestCapability,
  };
}

describe("NoticeSourceController", () => {
  it("serializes and deduplicates native start and stop operations", async () => {
    const native = source("calendar");
    const controller = new NoticeSourceController(native);

    await Promise.all([controller.start(), controller.start()]);
    expect(native.start).toHaveBeenCalledTimes(1);
    await Promise.all([controller.stop(), controller.stop()]);
    expect(native.stop).toHaveBeenCalledTimes(1);
  });

  it("isolates one source failure from another source controller", async () => {
    const failing = new NoticeSourceController(
      source("notification-mirror", vi.fn(async () => {
        throw new Error("MSIX capability unavailable");
      })),
    );
    const bluetooth = new NoticeSourceController(source("bluetooth"));

    await expect(failing.start()).rejects.toThrow("MSIX capability unavailable");
    await expect(bluetooth.start()).resolves.toEqual(capability("available"));
  });

  it("rejects malformed native capability responses without becoming active", async () => {
    const native = source(
      "calendar",
      vi
        .fn()
        .mockResolvedValueOnce({ state: "available" })
        .mockResolvedValueOnce(capability("available")),
    );
    const controller = new NoticeSourceController(native);

    await expect(controller.start()).rejects.toThrow("invalid capability");
    await expect(controller.start()).resolves.toEqual(capability("available"));
    expect(native.start).toHaveBeenCalledTimes(2);
  });

  it("captures a registry source identifier exactly once", () => {
    let reads = 0;
    const native = {
      ...source("unused"),
      get source() {
        reads += 1;
        return "stateful-source";
      },
    };

    const controller = registerNoticeSource(native);
    expect(controller.sourceName).toBe("stateful-source");
    expect(reads).toBe(1);
  });
});
