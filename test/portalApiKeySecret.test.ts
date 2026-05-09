import { describe, expect, it } from "vitest";
import { openPortalApiKeySecret, sealPortalApiKeySecret } from "../src/lib/portalApiKeySecret";

describe("portalApiKeySecret", () => {
  it("round-trips plaintext", () => {
    const plaintext = "ak_live_test_secret_value";
    const sealed = sealPortalApiKeySecret(plaintext);
    expect(sealed).not.toContain(plaintext);
    expect(openPortalApiKeySecret(sealed)).toBe(plaintext);
  });

  it("returns null for invalid sealed blobs", () => {
    expect(openPortalApiKeySecret("not-base64!!!")).toBeNull();
    expect(openPortalApiKeySecret("")).toBeNull();
  });
});
