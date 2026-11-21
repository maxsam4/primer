import { Parser } from 'acorn';
import jsx from 'acorn-jsx';

/** An acorn (ESTree + JSX) node. JSX node types are not in acorn's typings. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AstNode = { type: string; start: number; end: number; loc?: { start: { line: number; column: number } }; [key: string]: any };

export type WidgetError = { line: number; message: string; fix: string };

export type ParsedWidget = {
  /** The parsed program (of the wrapped source for a bare `<svg>` module). */
  ast: AstNode;
  /** A script that defines `__render`; JSX compiled to `__h(tag, props, ...children)`.
   *  Every byte outside JSX is kept and lines keep their numbers. */
  code: string;
  /** The text the AST offsets point into. */
  text: string;
};

const JsxParser = Parser.extend(jsx());

/** A module is `<svg>…</svg>` or JS/JSX with `export default function render({ rows, tokens })`. */
function isBareSvg(source: string): boolean {
  return source.trimStart().startsWith('<');
}

/**
 * The one parser of widget modules: acorn with JSX. A bare `<svg>` module is
 * read as the body of `render({ rows, tokens })`, on the same lines, so
 * `fill={tokens.fg}` works there too. Throws a `WidgetSyntaxError` with the
 * line of the first syntax error.
 */
export function parseWidget(source: string): ParsedWidget {
  const text = isBareSvg(source) ? `export default ({ rows, tokens }) => (${source}\n);` : source;
  let ast: AstNode;
  try {
    ast = JsxParser.parse(text, { ecmaVersion: 'latest', sourceType: 'module', locations: true }) as unknown as AstNode;
  } catch (e) {
    const err = e as SyntaxError & { loc?: { line: number } };
    throw new WidgetSyntaxError({
      line: err.loc?.line ?? 1,
      message: err.message.replace(/\s*\(\d+:\d+\)$/, ''),
      fix: 'Fix the syntax: the module is one JSX/SVG source with no imports.',
    });
  }
  return { ast, code: emit(text, ast), text };
}

export class WidgetSyntaxError extends Error {
  constructor(readonly error: WidgetError) {
    super(error.message);
  }
}

// ───────────────────────── JSX → __h() emitter ─────────────────────────

const SKIP_KEYS = new Set(['type', 'start', 'end', 'loc', 'range']);

/** The outermost JSX nodes under `node` (not descending into them). */
function outermostJsx(node: AstNode, out: AstNode[] = []): AstNode[] {
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const value = node[key];
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (!child || typeof child.type !== 'string') continue;
      if (child.type === 'JSXElement' || child.type === 'JSXFragment') out.push(child);
      else outermostJsx(child, out);
    }
  }
  return out;
}

function newlines(text: string, from: number, to: number): string {
  let n = 0;
  for (let i = from; i < to; i++) if (text.charCodeAt(i) === 10) n++;
  return '\n'.repeat(n);
}

/**
 * The program as a script: `export default X` becomes `const __render = X`
 * and every JSX node becomes a `__h()` call. Only those ranges change.
 */
function emit(text: string, ast: AstNode): string {
  const edits: { start: number; end: number; code: string }[] = [];
  for (const statement of ast.body as AstNode[]) {
    if (statement.type === 'ExportDefaultDeclaration') {
      // Only the keywords change: a parenthesized expression keeps both its parens.
      const keywords = /^export\s+default\s*/.exec(text.slice(statement.start))![0].length;
      edits.push({ start: statement.start, end: statement.start + keywords, code: 'const __render = ' });
    }
  }
  for (const node of outermostJsx(ast)) edits.push({ start: node.start, end: node.end, code: emitJsx(text, node) });
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.code + out.slice(edit.end);
  return out;
}

/** A non-JSX node's source with any JSX inside it compiled. */
function emitExpression(text: string, node: AstNode): string {
  if (node.type === 'JSXElement' || node.type === 'JSXFragment') return emitJsx(text, node);
  let out = text.slice(node.start, node.end);
  for (const jsxNode of outermostJsx(node).sort((a, b) => b.start - a.start)) {
    out = out.slice(0, jsxNode.start - node.start) + emitJsx(text, jsxNode) + out.slice(jsxNode.end - node.start);
  }
  return out;
}

function tagExpression(text: string, name: AstNode): string {
  if (name.type === 'JSXIdentifier') {
    return /^[a-z]/.test(name.name) || name.name.includes('-') ? JSON.stringify(name.name) : name.name;
  }
  if (name.type === 'JSXNamespacedName') return JSON.stringify(`${name.namespace.name}:${name.name.name}`);
  return text.slice(name.start, name.end); // JSXMemberExpression: a component reference
}

function attributeName(name: AstNode): string {
  return name.type === 'JSXNamespacedName' ? `${name.namespace.name}:${name.name.name}` : name.name;
}

function emitJsx(text: string, node: AstNode): string {
  const parts: { start: number; end: number; code: string }[] = [];
  let open: string;
  if (node.type === 'JSXFragment') {
    open = `__h(__Fragment, null`;
  } else {
    const opening = node.openingElement;
    const props: { start: number; end: number; code: string }[] = [];
    for (const attr of opening.attributes as AstNode[]) {
      if (attr.type === 'JSXSpreadAttribute') {
        props.push({ start: attr.start, end: attr.end, code: `...${emitExpression(text, attr.argument)}` });
        continue;
      }
      const key = JSON.stringify(attributeName(attr.name));
      let value = 'true';
      if (attr.value?.type === 'Literal') value = JSON.stringify(attr.value.value);
      else if (attr.value?.type === 'JSXExpressionContainer') value = emitExpression(text, attr.value.expression);
      else if (attr.value) value = emitJsx(text, attr.value);
      props.push({ start: attr.start, end: attr.end, code: `${key}: ${value}` });
    }
    let propsCode = 'null';
    if (props.length > 0) {
      let cursor = opening.name.end;
      propsCode = '{';
      props.forEach((prop, i) => {
        propsCode += `${i > 0 ? ', ' : ''}${newlines(text, cursor, prop.start)}${prop.code}`;
        cursor = prop.end;
      });
      propsCode += '}';
    }
    open = `__h(${tagExpression(text, opening.name)}, ${propsCode}`;
  }
  for (const child of node.children as AstNode[]) {
    if (child.type === 'JSXText') {
      const value = cleanJsxText(child.value);
      parts.push({ start: child.start, end: child.end, code: value === null ? '' : JSON.stringify(value) });
    } else if (child.type === 'JSXExpressionContainer') {
      const code = child.expression.type === 'JSXEmptyExpression' ? '' : emitExpression(text, child.expression);
      parts.push({ start: child.start, end: child.end, code });
    } else if (child.type === 'JSXSpreadChild') {
      parts.push({ start: child.start, end: child.end, code: `...${emitExpression(text, child.expression)}` });
    } else {
      parts.push({ start: child.start, end: child.end, code: emitJsx(text, child) });
    }
  }
  // Keep every newline of the original element so later lines keep their numbers.
  const openEnd = node.type === 'JSXFragment' ? node.openingFragment.end : node.openingElement.end;
  let out = padTo(open, text, node.start, openEnd);
  let cursor = openEnd;
  for (const part of parts) {
    out += newlines(text, cursor, part.start);
    out += padTo(part.code === '' ? '' : `, ${part.code}`, text, part.start, part.end);
    cursor = part.end;
  }
  return `${out}${newlines(text, cursor, node.end)})`;
}

/** `code` followed by the newlines of `text[from, to)` that it lacks. */
function padTo(code: string, text: string, from: number, to: number): string {
  const missing = newlines(text, from, to).length - (code.match(/\n/g)?.length ?? 0);
  return code + '\n'.repeat(Math.max(0, missing));
}

/** React's whitespace rule for JSX text: lines are trimmed and joined with a
 *  space; whitespace-only text that spans lines disappears. */
function cleanJsxText(raw: string): string | null {
  const lines = raw.split(/\r\n|\n|\r/);
  let out = '';
  lines.forEach((line, i) => {
    let trimmed = line.replace(/\t/g, ' ');
    if (i !== 0) trimmed = trimmed.replace(/^[ ]+/, '');
    if (i !== lines.length - 1) trimmed = trimmed.replace(/[ ]+$/, '');
    if (trimmed) out += (out ? ' ' : '') + trimmed;
  });
  return out === '' ? null : out;
}
