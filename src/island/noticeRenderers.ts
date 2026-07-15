import type { ComponentType } from "react";
import type { NoticeEvent } from "../store/notices";

export interface NoticeSurface {
  w: number;
  h: number;
  r: number;
}

export interface NoticeRendererProps {
  notice: NoticeEvent;
}

export interface NoticeRendererRegistration {
  source: string;
  size: NoticeSurface;
  Component: ComponentType<NoticeRendererProps>;
}

interface NoticeRendererGlobal {
  __winDynamicIslandNoticeRenderers?: Map<string, NoticeRendererRegistration>;
}

const rendererGlobal = globalThis as typeof globalThis & NoticeRendererGlobal;
const renderers =
  rendererGlobal.__winDynamicIslandNoticeRenderers ??
  new Map<string, NoticeRendererRegistration>();
rendererGlobal.__winDynamicIslandNoticeRenderers = renderers;

export function registerNoticeRenderer(
  registration: NoticeRendererRegistration,
): void {
  if (!registration.source.trim()) {
    throw new Error("Notice renderer source must be non-empty");
  }
  if (
    ![registration.size.w, registration.size.h, registration.size.r].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  ) {
    throw new Error("Notice renderer geometry must be positive and finite");
  }
  renderers.set(registration.source, registration);
}

export function getNoticeRenderer(
  source: string,
): NoticeRendererRegistration | undefined {
  return renderers.get(source);
}
