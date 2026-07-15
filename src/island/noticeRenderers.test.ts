import { describe, expect, it } from "vitest";
import {
  getNoticeRenderer,
  registerNoticeRenderer,
  type NoticeRendererProps,
} from "./noticeRenderers";

function TestRenderer(_props: NoticeRendererProps) {
  return null;
}

describe("notice renderer registry", () => {
  it("registers provider renderers without shell source branches", () => {
    registerNoticeRenderer({
      source: "notification-mirror",
      size: { w: 380, h: 56, r: 28 },
      Component: TestRenderer,
    });

    expect(getNoticeRenderer("notification-mirror")).toMatchObject({
      source: "notification-mirror",
      size: { w: 380, h: 56, r: 28 },
      Component: TestRenderer,
    });
  });

  it("rejects invalid renderer geometry", () => {
    expect(() =>
      registerNoticeRenderer({
        source: "invalid",
        size: { w: 0, h: 56, r: 28 },
        Component: TestRenderer,
      }),
    ).toThrow("positive and finite");
  });
});
