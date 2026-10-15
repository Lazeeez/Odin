// Parse issue texts (JSON on stdin) with the website's mention parser in multi-language mode;
// print what it found, for tests/test_mentions_languages.py to compare with Python.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "../../web");
const { parseMentions, moduleName, pathMatches } = await import(pathToFileURL(resolve(web, "src/engine/mentions.ts")).href);
const { texts, paths, pairs } = JSON.parse(readFileSync(0, "utf8"));
const out = {
  mentions: texts.map((t) => {
    const m = parseMentions(t, true);
    return { frameNames: [...m.frameNames].sort(), framePaths: m.framePaths, pyPaths: m.pyPaths, lastFrame: m.lastFrame };
  }),
  modules: paths.map((p) => moduleName(p, true)),
  matches: pairs.map(([a, b]) => pathMatches(a, b, true)),
};
process.stdout.write(JSON.stringify(out));
