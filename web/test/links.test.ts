import { describe, expect, it } from "vitest";
import { issueNumber, parseRepo } from "../src/engine/github.ts";
import { duration } from "../src/lib/format.ts";

describe("issue links", () => {
  it("finds the issue or pull request number in anything people paste", () => {
    expect(issueNumber("https://github.com/psf/requests/issues/6643")).toBe("6643");
    expect(issueNumber("github.com/pallets/flask/issues/5472#issuecomment-1")).toBe("5472");
    expect(issueNumber("www.github.com/pallets/flask/pull/12")).toBe("12");
    expect(issueNumber("pallets/flask/issues/7")).toBe("7");
  });

  it("finds nothing in a plain repository or a file link", () => {
    expect(issueNumber("pallets/flask")).toBeNull();
    expect(issueNumber("https://github.com/pallets/flask/tree/main/src")).toBeNull();
    expect(issueNumber("https://github.com/pallets/flask/blob/main/issues/5.py")).toBeNull();
  });

  it("still loads the repository the issue belongs to", () => {
    expect(parseRepo("https://github.com/psf/requests/issues/6643")).toEqual({ owner: "psf", name: "requests", ref: null });
  });
});

describe("durations", () => {
  it("shows milliseconds under a second instead of rounding to 0.0 s", () => {
    expect(duration(35)).toBe("35 ms");
    expect(duration(0.2)).toBe("1 ms");
    expect(duration(999.4)).toBe("999 ms");
    expect(duration(1349)).toBe("1.3 s");
  });
});
