export interface NoticeSourceCapability<TState extends string = string> {
  state: TState;
  observedAtMs: number;
  recoverable: boolean;
  reason: string | null;
}

/**
 * Each native-backed provider owns its commands and capability DTO. The shared
 * controller only serializes lifecycle calls and makes start/stop idempotent.
 */
export interface NativeNoticeSource<TCapability extends NoticeSourceCapability> {
  source: string;
  start: () => Promise<unknown>;
  stop: () => Promise<unknown>;
  reconcile: () => Promise<unknown>;
  getCapability: () => Promise<unknown>;
  isCapability: (value: unknown) => value is TCapability;
}

export class NoticeSourceController<
  TCapability extends NoticeSourceCapability,
> {
  private active = false;
  private operation: Promise<void> = Promise.resolve();
  readonly sourceName: string;

  constructor(
    private readonly source: NativeNoticeSource<TCapability>,
  ) {
    this.sourceName = source.source;
    if (!this.sourceName.trim()) {
      throw new Error("Native notice source must be non-empty");
    }
  }

  start(): Promise<TCapability> {
    return this.enqueue(async () => {
      if (this.active) {
        return this.requireCapability(await this.source.getCapability());
      }
      const capability = this.requireCapability(await this.source.start());
      this.active = true;
      return capability;
    });
  }

  stop(): Promise<TCapability> {
    return this.enqueue(async () => {
      if (!this.active) {
        return this.requireCapability(await this.source.getCapability());
      }
      const capability = this.requireCapability(await this.source.stop());
      this.active = false;
      return capability;
    });
  }

  reconcile(): Promise<TCapability> {
    return this.enqueue(async () =>
      this.requireCapability(await this.source.reconcile()),
    );
  }

  getCapability(): Promise<TCapability> {
    return this.enqueue(async () =>
      this.requireCapability(await this.source.getCapability()),
    );
  }

  private enqueue(
    action: () => Promise<TCapability>,
  ): Promise<TCapability> {
    const next = this.operation.then(action, action);
    this.operation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private requireCapability(value: unknown): TCapability {
    if (!this.source.isCapability(value)) {
      throw new Error(
        `Native notice source "${this.sourceName}" returned an invalid capability`,
      );
    }
    return value;
  }
}

interface NoticeSourceGlobal {
  __winDynamicIslandNoticeSources?: Map<
    string,
    NoticeSourceController<NoticeSourceCapability>
  >;
}

const sourceGlobal = globalThis as typeof globalThis & NoticeSourceGlobal;
const sources =
  sourceGlobal.__winDynamicIslandNoticeSources ??
  new Map<string, NoticeSourceController<NoticeSourceCapability>>();
sourceGlobal.__winDynamicIslandNoticeSources = sources;

export function registerNoticeSource<
  TCapability extends NoticeSourceCapability,
>(
  source: NativeNoticeSource<TCapability>,
): NoticeSourceController<TCapability> {
  const controller = new NoticeSourceController(source);
  const sourceName = controller.sourceName;
  if (sources.has(sourceName)) {
    throw new Error(
      `Native notice source "${sourceName}" is already registered`,
    );
  }
  sources.set(sourceName, controller);
  return controller;
}

export function getNoticeSource(
  source: string,
): NoticeSourceController<NoticeSourceCapability> | undefined {
  return sources.get(source);
}
