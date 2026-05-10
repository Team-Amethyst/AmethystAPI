import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { isAllowedNewsSignalsWebhookUrl } from "../src/lib/newsSignalsWebhookUrl";

describe("isAllowedNewsSignalsWebhookUrl", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows https URLs", () => {
    expect(isAllowedNewsSignalsWebhookUrl("https://api.example.com/hook")).toBe(
      true
    );
  });

  it("allows http for localhost in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isAllowedNewsSignalsWebhookUrl("http://localhost:3000/hook")).toBe(
      true
    );
  });

  it("disallows http non-localhost in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isAllowedNewsSignalsWebhookUrl("http://internal.dev/hook")).toBe(
      false
    );
  });
});
