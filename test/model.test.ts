import { describe, expect, it } from "vitest";
import { newId } from "../src/model.js";

describe("newId", () => {
  it("is a ULID: 26 Crockford characters, ordered by time", () => {
    const earlier = newId(1_700_000_000_000);
    const later = newId(1_700_000_000_001);
    expect(earlier).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(earlier.slice(0, 10) < later.slice(0, 10)).toBe(true);
  });
});
