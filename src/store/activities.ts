import { create } from "zustand";
import {
  ActivityCoordinator,
  type ActivityInput,
  type ActivitySnapshot,
  type CoordinatorSnapshot,
} from "../activity/coordinator";

const coordinator = new ActivityCoordinator();
const transientTimers = new Map<string, number>();

interface ActivityStore {
  revision: number;
}

export const useActivities = create<ActivityStore>(() => ({ revision: 0 }));

function publish(changed: boolean): void {
  if (changed) {
    useActivities.setState((state) => ({ revision: state.revision + 1 }));
  }
}

export function replaceActivitySource(sourceId: string, activities: ActivityInput[]): void {
  publish(coordinator.replaceSource(sourceId, activities));
}

export function upsertActivity(activity: ActivityInput): void {
  publish(coordinator.upsert(activity));
}

export function removeActivity(id: string): void {
  const timer = transientTimers.get(id);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    transientTimers.delete(id);
  }
  publish(coordinator.remove(id));
}

export function removeActivitySource(sourceId: string): void {
  publish(coordinator.removeSource(sourceId));
}

export function selectActivity(id: string | null): void {
  publish(coordinator.select(id));
}

export function getActivitySnapshot(): CoordinatorSnapshot {
  return coordinator.snapshot();
}

export function getActivity(id: string): ActivitySnapshot | null {
  return coordinator.get(id);
}

export function showTransientHud(activity: ActivityInput, durationMs: number): void {
  const existing = transientTimers.get(activity.id);
  if (existing !== undefined) window.clearTimeout(existing);
  publish(coordinator.upsert(activity));
  transientTimers.set(
    activity.id,
    window.setTimeout(() => {
      transientTimers.delete(activity.id);
      publish(coordinator.remove(activity.id));
    }, durationMs),
  );
}
