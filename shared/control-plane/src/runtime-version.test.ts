import { describe, expect, it } from "vitest";
import {
  MINIMUM_NODE_VERSION,
  assertSupportedNodeVersion,
  supportsBridgeNodeVersion,
} from "./runtime-version.js";

describe("Node runtime requirement", () => {
  it("accepts the minimum release and newer majors", () => {
    expect(MINIMUM_NODE_VERSION).toBe("22.13.0");
    expect(supportsBridgeNodeVersion("22.13.0")).toBe(true);
    expect(supportsBridgeNodeVersion("v22.22.0")).toBe(true);
    expect(supportsBridgeNodeVersion("23.0.0")).toBe(true);
  });

  it("rejects versions where node:sqlite needs a flag or does not exist", () => {
    expect(supportsBridgeNodeVersion("22.12.0")).toBe(false);
    expect(supportsBridgeNodeVersion("22.5.0")).toBe(false);
    expect(supportsBridgeNodeVersion("20.11.0")).toBe(false);
  });

  it("fails unsupported and malformed versions with an actionable message", () => {
    expect(() => assertSupportedNodeVersion("20.11.0")).toThrow(
      /requires Node\.js 22\.13\.0 or newer.*node:sqlite.*detected Node\.js 20\.11\.0.*Upgrade Node\.js/su,
    );
    expect(() => assertSupportedNodeVersion("unknown")).toThrow(/detected Node\.js unknown/u);
  });
});
