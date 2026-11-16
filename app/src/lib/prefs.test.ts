import { describe, expect, it } from "vitest";
import { parsePrefs } from "./prefs.ts";

const DEFAULTS = { theme: "dark", favoriteTeam: null, sources: {}, liveDelaySeconds: 0, liveDelayOn: true };

describe("parsePrefs", () => {
  it("gives defaults for nothing, junk and the wrong shape", () => {
    for (const raw of [null, "", "not json", "null", "[]", "42", '"dark"']) expect(parsePrefs(raw)).toEqual(DEFAULTS);
  });
  it("keeps good fields and resets only the bad ones", () => {
    const raw = JSON.stringify({ theme: "light", favoriteTeam: "XYZ", sources: { superBowl: "kalshi" }, liveDelaySeconds: -5 });
    expect(parsePrefs(raw)).toEqual({ theme: "light", favoriteTeam: null, sources: { superBowl: "kalshi" }, liveDelaySeconds: 0, liveDelayOn: true });
  });
  it("reads a full valid value", () => {
    const value = { theme: "light", favoriteTeam: "KC", sources: { wins: "hub" }, liveDelaySeconds: 45, liveDelayOn: false };
    expect(parsePrefs(JSON.stringify(value))).toEqual(value);
  });
  it("ignores unknown keys from a newer version", () => {
    expect(parsePrefs(JSON.stringify({ theme: "light", somethingNew: 1 }))).toEqual({ ...DEFAULTS, theme: "light" });
  });
});
