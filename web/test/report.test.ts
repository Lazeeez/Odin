import { describe, expect, it } from "vitest";
import { inlineSpans, reportBlocks } from "../src/lib/report.ts";

describe("bug report formatting", () => {
  it("keeps a fenced block as code, exactly", () => {
    const blocks = reportBlocks("It crashes:\n```python\nimport flask\n\nflask.url_for('x')\n```\nThanks!");
    expect(blocks).toEqual([
      { kind: "prose", text: "It crashes:" },
      { kind: "code", text: "import flask\n\nflask.url_for('x')" },
      { kind: "prose", text: "Thanks!" },
    ]);
  });

  it("finds a tab-indented traceback in a Trac-style report", () => {
    const text = 'Crash on proxy models.\nDescription\n\t\nI get an error:\nTraceback (most recent call last):\n File "manage.py", line 22, in <module>\n\tmain()\nValueError: \'id\' is not in list\nModels:';
    const blocks = reportBlocks(text);
    expect(blocks.map((b) => b.kind)).toEqual(["prose", "code", "prose"]);
    expect(blocks[1].text).toBe('Traceback (most recent call last):\n File "manage.py", line 22, in <module>\n    main()\nValueError: \'id\' is not in list');
  });

  it("treats a doctest session and a code snippet as code, and plain sentences as prose", () => {
    const blocks = reportBlocks("Steps:\n>>> import xarray as xr\n>>> ds = xr.Dataset()\n\nThe repr has trailing whitespace.");
    expect(blocks).toEqual([
      { kind: "prose", text: "Steps:" },
      { kind: "code", text: ">>> import xarray as xr\n>>> ds = xr.Dataset()" },
      { kind: "prose", text: "The repr has trailing whitespace." },
    ]);
    expect(reportBlocks("Fixing the parser would help.\nIt returns wrong results.")).toEqual([
      { kind: "prose", text: "Fixing the parser would help.\nIt returns wrong results." },
    ]);
  });

  it("keeps a call that spans lines together, even when its arguments are not indented", () => {
    const text = "Models:\nclass AnotherModel(models.Model):\n\tcustom = models.ForeignKey(\nProxyCustomModel,\non_delete=models.SET_NULL,\n\t)\nCommand:";
    expect(reportBlocks(text)).toEqual([
      { kind: "prose", text: "Models:" },
      { kind: "code", text: "class AnotherModel(models.Model):\n    custom = models.ForeignKey(\nProxyCustomModel,\non_delete=models.SET_NULL,\n    )" },
      { kind: "prose", text: "Command:" },
    ]);
  });

  it("ignores brackets inside strings and comments", () => {
    expect(reportBlocks("    print(\"(\")  # (\nDone.")).toEqual([
      { kind: "code", text: "    print(\"(\")  # (" },
      { kind: "prose", text: "Done." },
    ]);
  });

  it("closes a fence the report never closed", () => {
    expect(reportBlocks("```\nx = 1")).toEqual([{ kind: "code", text: "x = 1" }]);
  });

  it("splits backticked names out of prose", () => {
    expect(inlineSpans("Use `url_for` with `_external`.")).toEqual([
      { code: false, text: "Use " },
      { code: true, text: "url_for" },
      { code: false, text: " with " },
      { code: true, text: "_external" },
      { code: false, text: "." },
    ]);
  });
});
