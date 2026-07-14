export type ActivityChannel = "hud" | "ongoing" | "ambient";

export interface ActivitySnapshot {
  id: string;
  sourceId: string;
  moduleId: string;
  channel: ActivityChannel;
  title: string;
  icon: string;
  priority: number;
  sequence: number;
}

export type ActivityInput = Omit<ActivitySnapshot, "sequence">;

export interface CoordinatorSnapshot {
  activities: ActivitySnapshot[];
  selectedId: string | null;
  base: ActivitySnapshot | null;
  preemption: ActivitySnapshot | null;
  visible: ActivitySnapshot | null;
}

function sameActivity(left: ActivitySnapshot, right: ActivityInput): boolean {
  return (
    left.sourceId === right.sourceId &&
    left.moduleId === right.moduleId &&
    left.channel === right.channel &&
    left.title === right.title &&
    left.icon === right.icon &&
    left.priority === right.priority
  );
}

function byPriority(left: ActivitySnapshot, right: ActivitySnapshot): number {
  return right.priority - left.priority || right.sequence - left.sequence;
}

export class ActivityCoordinator {
  private readonly activities = new Map<string, ActivitySnapshot>();
  private sequence = 0;
  private selectedId: string | null = null;

  upsert(input: ActivityInput): boolean {
    const current = this.activities.get(input.id);
    if (current && sameActivity(current, input)) return false;
    this.activities.set(input.id, { ...input, sequence: ++this.sequence });
    this.reconcileSelection();
    return true;
  }

  remove(id: string): boolean {
    const changed = this.activities.delete(id);
    if (changed) this.reconcileSelection();
    return changed;
  }

  removeSource(sourceId: string): boolean {
    let changed = false;
    for (const activity of this.activities.values()) {
      if (activity.sourceId === sourceId) {
        this.activities.delete(activity.id);
        changed = true;
      }
    }
    if (changed) this.reconcileSelection();
    return changed;
  }

  replaceSource(sourceId: string, inputs: ActivityInput[]): boolean {
    const nextIds = new Set(inputs.map((activity) => activity.id));
    let changed = false;
    for (const activity of this.activities.values()) {
      if (activity.sourceId === sourceId && !nextIds.has(activity.id)) {
        this.activities.delete(activity.id);
        changed = true;
      }
    }
    for (const activity of inputs) {
      if (activity.sourceId !== sourceId) {
        throw new Error(`Activity "${activity.id}" does not belong to source "${sourceId}"`);
      }
      changed = this.upsert(activity) || changed;
    }
    if (changed) this.reconcileSelection();
    return changed;
  }

  select(id: string | null): boolean {
    if (id === null) {
      if (this.selectedId === null) return false;
      this.selectedId = null;
      return true;
    }
    const activity = this.activities.get(id);
    if (!activity || activity.channel !== "ongoing") return false;
    if (this.selectedId === id) return false;
    this.selectedId = id;
    return true;
  }

  get(id: string): ActivitySnapshot | null {
    return this.activities.get(id) ?? null;
  }

  getBase(): ActivitySnapshot | null {
    const ongoing = this.list("ongoing");
    const selected = this.selectedId ? this.activities.get(this.selectedId) : undefined;
    if (selected?.channel === "ongoing") return selected;
    if (ongoing.length) return ongoing[0];
    return this.list("ambient")[0] ?? null;
  }

  getPreemption(): ActivitySnapshot | null {
    return this.list("hud")[0] ?? null;
  }

  getVisible(): ActivitySnapshot | null {
    return this.getPreemption() ?? this.getBase();
  }

  list(channel?: ActivityChannel): ActivitySnapshot[] {
    return [...this.activities.values()]
      .filter((activity) => !channel || activity.channel === channel)
      .sort(byPriority);
  }

  snapshot(): CoordinatorSnapshot {
    const base = this.getBase();
    const preemption = this.getPreemption();
    return {
      activities: this.list(),
      selectedId: this.selectedId,
      base,
      preemption,
      visible: preemption ?? base,
    };
  }

  private reconcileSelection(): void {
    if (
      this.selectedId &&
      this.activities.get(this.selectedId)?.channel !== "ongoing"
    ) {
      this.selectedId = null;
    }
  }
}
