const LANGUAGES: [RegExp, string][] = [
  [/\.pyi?$/i, "Python"],
  [/\.(ts|tsx|mts|cts)$/i, "TypeScript"],
  [/\.(js|jsx|mjs|cjs)$/i, "JavaScript"],
  [/\.(vue|svelte)$/i, "Vue/Svelte"],
  [/\.go$/i, "Go"],
  [/\.rs$/i, "Rust"],
  [/\.java$/i, "Java"],
  [/\.(kt|kts)$/i, "Kotlin"],
  [/\.(c|h)$/i, "C"],
  [/\.(cc|cpp|cxx|hh|hpp|hxx)$/i, "C++"],
  [/\.cs$/i, "C#"],
  [/\.rb$/i, "Ruby"],
  [/\.php$/i, "PHP"],
  [/\.swift$/i, "Swift"],
  [/\.dart$/i, "Dart"],
  [/\.scala$/i, "Scala"],
];
const NOT_SOURCE = /(^|\/)(node_modules|vendor|third[_-]party|dist|build|\.next|out|coverage|site-packages|\.?venv\d*)(\/|$)|\.min\.js$|\.d\.ts$/i;

export class LanguageCensus {
  readonly counts = new Map<string, number>();

  add(path: string): void {
    if (NOT_SOURCE.test(path)) return;
    const hit = LANGUAGES.find(([re]) => re.test(path));
    if (hit) this.counts.set(hit[1], (this.counts.get(hit[1]) ?? 0) + 1);
  }

  others(): [string, number][] {
    return [...this.counts].filter(([lang]) => lang !== "Python").sort((a, b) => b[1] - a[1]);
  }

  describe(): string {
    return this.others().slice(0, 3).map(([lang, n]) => `${lang} (${n.toLocaleString()} file${n === 1 ? "" : "s"})`).join(", ");
  }

  note(): string | null {
    const python = this.counts.get("Python") ?? 0;
    const other = this.others().reduce((n, [, c]) => n + c, 0);
    if (!other || python >= other) return null;
    return `Most of this repository is ${this.describe()}. Odin reads Python only for now, so it searched just the ${python.toLocaleString()} Python file${python === 1 ? "" : "s"}; code in other languages isn't in these results.`;
  }

  noPython(): string {
    const others = this.describe();
    return others ? `No Python files found: this repository is ${others}. Odin reads Python only for now.` : "No Python files found. Odin searches Python code only for now.";
  }
}
