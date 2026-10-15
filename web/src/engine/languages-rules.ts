import type { Node } from "web-tree-sitter";
import type { UnitKind } from "./types.ts";

export type Lang = "python" | "javascript" | "typescript" | "tsx" | "go" | "java" | "rust";

const EXTENSIONS: Record<string, Lang> = {
  ".py": "python",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".go": "go",
  ".java": "java",
  ".rs": "rust",
};

export function languageOf(path: string): Lang | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0 || path.endsWith(".d.ts") || path.endsWith(".min.js")) return null;
  return EXTENSIONS[path.slice(dot).toLowerCase()] ?? null;
}

export interface Found {
  name: string;
  kind: UnitKind | null;
  body: Node | null;
  start: Node;
  end: Node;
  unit: boolean;
}

const found = (name: string, kind: UnitKind | null, body: Node | null, start: Node, end: Node, unit = true): Found => ({ name, kind, body, start, end, unit });
const field = (node: Node, name: string): Node | null => node.childForFieldName(name);
const text = (node: Node | null): string | null => (node ? node.text : null);

const JS_FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);
const JS_STATEMENTS = new Set(["lexical_declaration", "variable_declaration", "export_statement"]);

function statementStart(node: Node): Node {
  let top = node;
  while (top.parent && JS_STATEMENTS.has(top.parent.type)) top = top.parent;
  return top;
}

function js(node: Node): Found | null {
  const t = node.type;
  if (t === "function_declaration" || t === "generator_function_declaration") {
    return found(text(field(node, "name")) ?? "default", "function", field(node, "body"), statementStart(node), node);
  }
  if (t === "class_declaration" || t === "abstract_class_declaration" || t === "class") {
    const name = text(field(node, "name"));
    if (name === null && t === "class") return null;
    return found(name ?? "default", "class", field(node, "body"), statementStart(node), node);
  }
  if (t === "interface_declaration" || t === "enum_declaration") {
    return found(text(field(node, "name")) ?? "<anonymous>", "class", field(node, "body"), statementStart(node), node);
  }
  if (t === "type_alias_declaration") {
    return found(text(field(node, "name")) ?? "<anonymous>", "class", null, statementStart(node), node);
  }
  if (t === "method_definition") {
    return found(text(field(node, "name")) ?? "<anonymous>", "function", field(node, "body"), node, node);
  }
  if (t === "public_field_definition" || t === "field_definition") {
    const value = field(node, "value");
    const name = field(node, "name") ?? field(node, "property");
    if (value && JS_FUNCTION_VALUES.has(value.type) && name) return found(text(name) ?? "<anonymous>", "function", field(value, "body"), node, node);
    return null;
  }
  if (t === "variable_declarator") {
    const name = field(node, "name");
    const value = field(node, "value");
    if (!name || name.type !== "identifier" || !value) return null;
    if (JS_FUNCTION_VALUES.has(value.type)) return found(text(name) ?? "<anonymous>", "function", field(value, "body"), statementStart(node), node);
    if (value.type === "object") return found(text(name) ?? "<anonymous>", null, value, node, node, false);
    return null;
  }
  if (t === "assignment_expression") {
    const left = field(node, "left");
    const right = field(node, "right");
    if (!left || !right || left.type !== "member_expression" || !JS_FUNCTION_VALUES.has(right.type)) return null;
    let qual = (text(left) ?? "").replaceAll(".prototype.", ".");
    for (const prefix of ["module.exports.", "exports."]) if (qual.startsWith(prefix)) qual = qual.slice(prefix.length);
    const start = node.parent && node.parent.type === "expression_statement" ? node.parent : node;
    return found(qual, "function", field(right, "body"), start, node);
  }
  return null;
}

function* descendants(node: Node): Generator<Node> {
  const stack = [node];
  while (stack.length) {
    const n = stack.pop()!;
    yield n;
    const kids = n.namedChildren.filter((c): c is Node => !!c);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
}

function goReceiver(node: Node): string {
  const receiver = field(node, "receiver");
  if (!receiver) return "";
  for (const n of descendants(receiver)) if (n.type === "type_identifier") return n.text;
  return "";
}

function go(node: Node): Found | null {
  const t = node.type;
  if (t === "function_declaration") return found(text(field(node, "name")) ?? "<anonymous>", "function", field(node, "body"), node, node);
  if (t === "method_declaration") {
    const name = text(field(node, "name")) ?? "<anonymous>";
    const receiver = goReceiver(node);
    return found(receiver ? `${receiver}.${name}` : name, "method", field(node, "body"), node, node);
  }
  if (t === "type_spec" || t === "type_alias") {
    const parent = node.parent;
    const start = parent && parent.type === "type_declaration" && parent.namedChildCount === 1 ? parent : node;
    return found(text(field(node, "name")) ?? "<anonymous>", "class", null, start, node);
  }
  return null;
}

const JAVA_TYPES = new Set(["class_declaration", "interface_declaration", "enum_declaration", "record_declaration", "annotation_type_declaration"]);
const JAVA_METHODS = new Set(["method_declaration", "constructor_declaration", "compact_constructor_declaration"]);

function java(node: Node): Found | null {
  if (JAVA_TYPES.has(node.type)) return found(text(field(node, "name")) ?? "<anonymous>", "class", field(node, "body"), node, node);
  if (JAVA_METHODS.has(node.type)) return found(text(field(node, "name")) ?? "<anonymous>", "function", field(node, "body"), node, node);
  return null;
}

function rustTypeName(node: Node | null): string {
  if (!node) return "<anonymous>";
  if (node.type === "generic_type" || node.type === "scoped_type_identifier") return rustTypeName(field(node, "type") ?? field(node, "name"));
  if (node.type === "reference_type" || node.type === "pointer_type") return rustTypeName(field(node, "type"));
  return node.text || "<anonymous>";
}

function rustTestModule(node: Node): boolean {
  if (["tests", "test"].includes(text(field(node, "name")) ?? "")) return true;
  for (let prev = node.previousNamedSibling; prev && prev.type === "attribute_item"; prev = prev.previousNamedSibling) {
    if (prev.text.replace(/\s+/g, "").includes("cfg(test)")) return true;
  }
  return false;
}

function rust(node: Node): Found | null {
  const t = node.type;
  if (t === "function_item") return found(text(field(node, "name")) ?? "<anonymous>", "function", field(node, "body"), node, node);
  if (t === "struct_item" || t === "enum_item" || t === "union_item") return found(text(field(node, "name")) ?? "<anonymous>", "class", null, node, node);
  if (t === "trait_item") return found(text(field(node, "name")) ?? "<anonymous>", "class", field(node, "body"), node, node);
  if (t === "impl_item") return found(rustTypeName(field(node, "type")), "class", field(node, "body"), node, node, false);
  if (t === "mod_item" && field(node, "body")) return found(text(field(node, "name")) ?? "<anonymous>", null, rustTestModule(node) ? null : field(node, "body"), node, node, false);
  return null;
}

export const RULES: Record<Exclude<Lang, "python">, (node: Node) => Found | null> = {
  javascript: js,
  typescript: js,
  tsx: js,
  go,
  java,
  rust,
};

const TEST_DIRS = new Set(["__tests__", "__mocks__", "e2e", "cypress", "testdata", "test-utils"]);

export function isTestPathAny(path: string): boolean {
  const parts = path.split("/");
  const name = parts[parts.length - 1].toLowerCase();
  const dirs = parts.slice(0, -1);
  if (name.startsWith("test_") || name.endsWith("_test.py") || name === "conftest.py" || dirs.some((p) => p === "tests" || p === "test" || p === "testing")) return true;
  const dot = name.lastIndexOf(".");
  const stem = dot >= 0 ? name.slice(0, dot) : name;
  return (
    [".test", ".spec", ".tests", ".specs", "_test"].some((s) => stem.endsWith(s)) ||
    dirs.some((p) => TEST_DIRS.has(p)) ||
    (name.endsWith(".java") && (stem.endsWith("test") || stem.endsWith("tests") || stem.endsWith("it")) && dirs.includes("src"))
  );
}
