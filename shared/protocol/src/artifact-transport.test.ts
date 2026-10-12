import { describe, expect, it } from "vitest";
import { artifactInputRecords, splitUtf8 } from "./artifact-transport.js";
import type { Artifact } from "./types.js";

describe("shared artifact transport", () => {
  it("preserves Unicode code points and exact content at a byte ceiling", () => {
    const text = "é😀漢\n".repeat(20_000);
    const chunks = splitUtf8(text, 61_440);
    expect(chunks.join("")).toBe(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(61_440);
      expect(Buffer.from(chunk, "utf8").toString("utf8")).toBe(chunk);
    }
  });
  it("refuses aggregate overflow rather than dropping later inputs", () => {
    const input = { inline: "x".repeat(60_000) } as Artifact;
    expect(() => artifactInputRecords([input, input], "Claude")).toThrow(/prompt limit/);
    expect(() => splitUtf8("😀", 3)).toThrow();
    expect(() => splitUtf8("\ud800", 65_536)).toThrow(/unpaired/);
  });
});
