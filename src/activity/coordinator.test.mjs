import assert from "node:assert/strict";
import test from "node:test";
import { ActivityCoordinator } from "./coordinator.ts";

const activity = (id, sourceId, priority, channel = "ongoing") => ({
  id,
  sourceId,
  moduleId: sourceId,
  channel,
  title: id,
  icon: id[0],
  priority,
});

test("stable ids dedupe repeated source updates", () => {
  const coordinator = new ActivityCoordinator();
  assert.equal(coordinator.upsert(activity("timer:a", "time", 200)), true);
  assert.equal(coordinator.upsert(activity("timer:a", "time", 200)), false);
  assert.equal(coordinator.list().length, 1);
});

test("source replacement removes stale activities and repairs selection", () => {
  const coordinator = new ActivityCoordinator();
  coordinator.replaceSource("time", [
    activity("timer:a", "time", 200),
    activity("timer:b", "time", 190),
  ]);
  coordinator.select("timer:b");
  coordinator.replaceSource("time", [activity("timer:a", "time", 200)]);
  const snapshot = coordinator.snapshot();
  assert.equal(snapshot.selectedId, null);
  assert.equal(snapshot.base?.id, "timer:a");
});

test("manual selection overrides priority", () => {
  const coordinator = new ActivityCoordinator();
  coordinator.upsert(activity("high", "one", 300));
  coordinator.upsert(activity("low", "two", 100));
  assert.equal(coordinator.getBase()?.id, "high");
  coordinator.select("low");
  assert.equal(coordinator.getBase()?.id, "low");
});

test("nested preemption restores the manual selection", () => {
  const coordinator = new ActivityCoordinator();
  coordinator.upsert(activity("timer:a", "time", 200));
  coordinator.upsert(activity("timer:b", "time", 100));
  coordinator.select("timer:b");
  coordinator.upsert(activity("volume", "volume", 500, "hud"));
  coordinator.upsert(activity("complete:a", "time", 1000, "hud"));
  assert.equal(coordinator.getVisible()?.id, "complete:a");
  coordinator.remove("complete:a");
  assert.equal(coordinator.getVisible()?.id, "volume");
  coordinator.remove("volume");
  assert.equal(coordinator.getVisible()?.id, "timer:b");
});

test("removing a selected activity falls back to the highest priority ongoing activity", () => {
  const coordinator = new ActivityCoordinator();
  coordinator.upsert(activity("timer:a", "time", 200));
  coordinator.upsert(activity("timer:b", "time", 100));
  coordinator.select("timer:b");
  coordinator.remove("timer:b");
  assert.equal(coordinator.snapshot().selectedId, null);
  assert.equal(coordinator.getBase()?.id, "timer:a");
});

test("simultaneous equal-priority completions restore in stack order", () => {
  const coordinator = new ActivityCoordinator();
  coordinator.upsert(activity("complete:a", "time", 1000, "hud"));
  coordinator.upsert(activity("complete:b", "time", 1000, "hud"));
  assert.equal(coordinator.getPreemption()?.id, "complete:b");
  coordinator.remove("complete:b");
  assert.equal(coordinator.getPreemption()?.id, "complete:a");
});

test("ambient activity never displaces an ongoing activity", () => {
  const coordinator = new ActivityCoordinator();
  coordinator.upsert(activity("weather", "weather", 900, "ambient"));
  coordinator.upsert(activity("timer", "time", 100, "ongoing"));
  assert.equal(coordinator.getBase()?.id, "timer");
  coordinator.remove("timer");
  assert.equal(coordinator.getBase()?.id, "weather");
});
