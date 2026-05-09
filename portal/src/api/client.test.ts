import { describe, expect, it } from "vitest";
import { portalApiMessage } from "./client";

describe("portalApiMessage", () => {
  it("reads express error shape", () => {
    expect(portalApiMessage({ message: "bad" })).toBe("bad");
  });

  it("falls back for unknown", () => {
    expect(portalApiMessage(null)).toBe("Request failed");
  });
});
