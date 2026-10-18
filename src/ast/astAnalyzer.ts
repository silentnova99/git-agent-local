/**
 * astAnalyzer — AST-aware structural change detection.
 *
 * For JS/TS files we parse BOTH sides of the diff with @babel/parser and
 * diff the resulting syntax trees (functions, classes, exports, signatures).
 * For other languages we fall back to a robust language-aware line scanner
 * (Python `def`/`class`, Go `func`, Rust `fn`, etc.) so no diff goes
 * un-analysed.
 */

import { parse as babelParse, type ParserOptions } from '@babel/parser';
import * as path from 'node:path';
import type {
  DiffAnalysis,
  FileDiff,
  ParsedDiff,
  StructuralChange,
} from '../types';

const JS_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);
const PY_EXT = new Set(['.py', '.pyi']);
const GO_EXT = new Set(['.go']);
const RUST_EXT = new Set(['.rs']);
const JAVA_EXT = new Set(['.java']);
const C_EXT = new Set(['.c', '.h', '.cpp', '.cc', '.hpp', '.cxx']);
const CONFIG_FILES = new Set([
  'package.json',
  'package-lock.json',
  'pyproject.toml',
  'cargo.toml',
  'go.mod',
  'go.sum',
  'dockerfile',
  'makefile',
]);
const DOC_EXT = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc']);
const STYLE_EXT = new Set(['.css', '.scss', '.less', '.sass']);
const LOCK_EXT = new Set(['.lock', '.yaml', '.yml', '.toml', '.ini', '.env']);

const BABEL_OPTS: ParserOptions = {
  sourceType: 'unambiguous',
  allowReturnOutsideFunction: true,
  errorRecovery: true,
  plugins: [
    'typescript',
    'jsx',
    'decorators-legacy',
    'classProperties',
    'classPrivateProperties',
    'classPrivateMethods',
    'dynamicImport',
    'importMeta',
    'topLevelAwait',
  ],
};

function tryBabelParse(
  source: string,
): ReturnType<typeof babelParse> | null {
  if (!source.trim()) return null;
  try {
    return babelParse(source, BABEL_OPTS);
  } catch {
    return null;
  }
}

interface SymbolInfo {
  name: string;
  signature: string;
  kind: 'function' | 'class' | 'method' | 'export';
}

/** Extract function/class/export signatures from a JS/TS source snapshot. */
function extractJsSymbols(source: string): Map<string, SymbolInfo> {
  const symbols = new Map<string, SymbolInfo>();
  let ast = tryBabelParse(source);
  if (!ast) {
    // Diff snapshots are partial file fragments: they can start with an
    // orphan "}" or end mid-block. Trim line boundaries until a window
    // parses, so structural extraction never silently degrades to empty.
    const lines = source.split('\n');
    search: for (
      let start = 0;
      start < Math.min(lines.length, 60);
      start++
    ) {
      for (
        let end = lines.length;
        end > Math.max(lines.length - 60, start);
        end--
      ) {
        ast = tryBabelParse(lines.slice(start, end).join('\n'));
        if (ast) break search;
      }
    }
  }
  if (!ast) return symbols;

  const paramsSource = (node: {
    params: unknown[];
  }): string => {
    const parts = node.params.map((p) => {
      // Best-effort textual parameter rendering.
      const anyP = p as Record<string, unknown> & { type: string };
      switch (anyP.type) {
        case 'Identifier':
          return String(anyP.name);
        case 'AssignmentPattern':
          return `${String((anyP.left as { name?: string })?.name ?? '…')}=…`;
        case 'RestElement': {
          const arg = anyP.argument as { name?: string };
          return `...${arg?.name ?? 'args'}`;
        }
        case 'ObjectPattern':
          return '{…}';
        case 'ArrayPattern':
          return '[…]';
        default:
          return '…';
      }
    });
    return parts.join(', ');
  };

  const returnType = (node: { returnType?: unknown }): string => {
    if (!node.returnType) return '';
    return ': …';
  };

  const visit = (node: unknown, exportName?: string): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown> & { type: string };

    switch (n.type) {
      case 'FunctionDeclaration': {
        const id = n.id as { name?: string } | null;
        const name = id?.name ?? 'anonymous';
        const fnNode = n as unknown as { params: unknown[]; returnType?: unknown };
        symbols.set(`fn:${name}`, {
          name,
          kind: 'function',
          signature: `function ${name}(${paramsSource(fnNode)})${returnType(fnNode)}`,
        });
        break;
      }
      case 'ClassDeclaration':
      case 'ClassExpression': {
        const id = n.id as { name?: string } | null;
        const name = id?.name ?? exportName ?? 'anonymous';
        const superCls = n.superClass
          ? ` extends ${String((n.superClass as { name?: string })?.name ?? '…')}`
          : '';
        symbols.set(`class:${name}`, {
          name,
          kind: 'class',
          signature: `class ${name}${superCls}`,
        });
        const body = n.body as { body?: unknown[] } | undefined;
        for (const member of body?.body ?? []) {
          const m = member as Record<string, unknown> & { type: string };
          if (m.type !== 'ClassMethod' && m.type !== 'ClassPrivateMethod')
            continue;
          const key = m.key as { name?: string; value?: unknown } | null;
          const methodName =
            key?.name ?? String(key?.value ?? (m.kind === 'constructor' ? 'constructor' : '?'));
          const mTyped = m as unknown as { params: unknown[]; returnType?: unknown };
          symbols.set(`method:${name}.${methodName}`, {
            name: `${name}.${methodName}`,
            kind: 'method',
            signature: `${methodName}(${paramsSource(mTyped)})${returnType(mTyped)}`,
          });
        }
        break;
      }
      case 'ExportNamedDeclaration': {
        const decl = n.declaration as Record<string, unknown> | null;
        if (decl) {
          const id = decl.id as { name?: string } | null;
          if (id?.name) {
            symbols.set(`export:${id.name}`, {
              name: id.name,
              kind: 'export',
              signature: `export ${String(decl.type)} ${id.name}`,
            });
          }
        } else {
          for (const spec of (n.specifiers as Array<{ exported: { name?: string } }>) ?? []) {
            const name = spec.exported?.name;
            if (name) {
              symbols.set(`export:${name}`, {
                name,
                kind: 'export',
                signature: `export { ${name} }`,
              });
            }
          }
        }
        break;
      }
      case 'ExportDefaultDeclaration': {
        const decl = n.declaration as { name?: string; type?: string } | null;
        const name = decl?.name ?? 'default';
        symbols.set(`export:default→${name}`, {
          name: `default (${name})`,
          kind: 'export',
          signature: `export default ${decl?.type ?? name}`,
        });
        break;
      }
      case 'CallExpression': {
        // Detect framework API endpoints: app.get('/x'), router.post('/x')
        const callee = n.callee as Record<string, unknown> | null;
        if (callee?.type === 'MemberExpression') {
          const obj = callee.object as { name?: string } | undefined;
          const prop = callee.property as { name?: string } | undefined;
          const method = prop?.name?.toLowerCase();
          if (
            obj &&
            ['app', 'router', 'server', 'fastify', 'koa', 'express'].includes(obj.name ?? '') &&
            method &&
            ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'].includes(method)
          ) {
            const args = n.arguments as Array<{ value?: unknown }>;
            const route = typeof args[0]?.value === 'string' ? args[0].value : '?';
            symbols.set(`route:${method.toUpperCase()} ${route}`, {
              name: `${method.toUpperCase()} ${route}`,
              kind: 'export',
              signature: `${obj.name}.${method}('${route}')`,
            });
          }
        }
        break;
      }
      default:
        break;
    }

    // Walk every object/array child generically.
    for (const value of Object.values(n)) {
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
      } else if (value && typeof value === 'object' && 'type' in value) {
        visit(value);
      }
    }
  };

  visit(ast.program);
  return symbols;
}

/** Language-aware fallback scanner for non-JS/TS files. */
function extractGenericSymbols(
  source: string,
  ext: string,
): Map<string, SymbolInfo> {
  const symbols = new Map<string, SymbolInfo>();
  const lines = source.split('\n');

  const push = (key: string, info: SymbolInfo) => symbols.set(key, info);

  if (ext === '.py' || ext === '.pyi') {
    for (const line of lines) {
      const fn = /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)/.exec(line);
      if (fn) {
        push(`fn:${fn[1]}`, {
          name: fn[1]!,
          kind: 'function',
          signature: `def ${fn[1]}(${fn[2]!.trim()})`,
        });
      }
      const cls = /^\s*class\s+([A-Za-z_][\w]*)\s*(?:\(([^)]*)\))?/.exec(line);
      if (cls) {
        push(`class:${cls[1]}`, {
          name: cls[1]!,
          kind: 'class',
          signature: `class ${cls[1]}${cls[2] ? `(${cls[2]!.trim()})` : ''}`,
        });
      }
    }
  } else if (ext === '.go') {
    for (const line of lines) {
      const fn = /^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][\w]*)\s*\(([^)]*)\)/.exec(line);
      if (fn) {
        push(`fn:${fn[1]}`, {
          name: fn[1]!,
          kind: 'function',
          signature: line.trim(),
        });
      }
      const typ = /^type\s+([A-Za-z_][\w]*)\s+(struct|interface)/.exec(line);
      if (typ) {
        push(`class:${typ[1]}`, {
          name: typ[1]!,
          kind: 'class',
          signature: line.trim(),
        });
      }
    }
  } else if (ext === '.rs') {
    for (const line of lines) {
      const fn = /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)/.exec(line);
      if (fn) {
        push(`fn:${fn[1]}`, {
          name: fn[1]!,
          kind: 'function',
          signature: line.trim(),
        });
      }
      const st = /^\s*(?:pub\s+)?struct\s+([A-Za-z_][\w]*)/.exec(line);
      if (st) {
        push(`class:${st[1]}`, {
          name: st[1]!,
          kind: 'class',
          signature: line.trim(),
        });
      }
    }
  } else if (ext === '.java') {
    for (const line of lines) {
      const fn = /^\s*(?:public|private|protected)?\s*(?:static\s+)?[\w<>\[\]]+\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)/.exec(line);
      if (fn && !['if', 'for', 'while', 'switch', 'catch', 'return'].includes(fn[1]!)) {
        push(`fn:${fn[1]}`, {
          name: fn[1]!,
          kind: 'function',
          signature: line.trim(),
        });
      }
      const cls = /^\s*(?:public\s+)?(?:abstract\s+)?(?:class|interface|enum)\s+([A-Za-z_][\w]*)/.exec(line);
      if (cls) {
        push(`class:${cls[1]}`, {
          name: cls[1]!,
          kind: 'class',
          signature: line.trim(),
        });
      }
    }
  } else if (C_EXT.has(ext)) {
    for (const line of lines) {
      const fn = /^[\w\s*]+\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)\s*\{?\s*$/.exec(line);
      if (fn && !['if', 'for', 'while', 'switch', 'return'].includes(fn[1]!)) {
        push(`fn:${fn[1]}`, {
          name: fn[1]!,
          kind: 'function',
          signature: `${fn[1]}(${fn[2]!.trim()})`,
        });
      }
    }
  }

  return symbols;
}

/** Reconstruct approximate full-file snapshots for the "before" side. */
function beforeSnapshot(file: FileDiff): string {
  const lines: string[] = [];
  for (const hunk of file.hunks) {
    for (const dl of hunk.lines) {
      if (dl.type !== 'add') lines.push(dl.content);
    }
  }
  return lines.join('\n');
}

function afterSnapshot(file: FileDiff): string {
  const lines: string[] = [];
  for (const hunk of file.hunks) {
    for (const dl of hunk.lines) {
      if (dl.type !== 'del') lines.push(dl.content);
    }
  }
  return lines.join('\n');
}

function extOf(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

function baseOf(filePath: string): string {
  return path.basename(filePath).toLowerCase();
}

function detectLanguages(files: FileDiff[]): string[] {
  const langs = new Set<string>();
  for (const f of files) {
    const ext = extOf(f.newPath || f.oldPath);
    if (JS_EXT.has(ext)) langs.add('javascript/typescript');
    else if (PY_EXT.has(ext)) langs.add('python');
    else if (GO_EXT.has(ext)) langs.add('go');
    else if (RUST_EXT.has(ext)) langs.add('rust');
    else if (JAVA_EXT.has(ext)) langs.add('java');
    else if (C_EXT.has(ext)) langs.add('c/c++');
    else if (ext === '.json') langs.add('json');
    else if (ext === '.sql') langs.add('sql');
    else if (ext === '.sh') langs.add('shell');
  }
  return [...langs];
}

/** Compare before/after symbol tables of one file into StructuralChanges. */
function diffSymbols(
  file: FileDiff,
  before: Map<string, SymbolInfo>,
  after: Map<string, SymbolInfo>,
): StructuralChange[] {
  const changes: StructuralChange[] = [];
  const filePath = file.newPath || file.oldPath;

  for (const [key, info] of after) {
    if (!before.has(key)) {
      const kind =
        info.kind === 'class'
          ? 'class-added'
          : info.kind === 'export'
            ? 'export-added'
            : 'function-added';
      changes.push({
        kind,
        symbol: info.name,
        signature: info.signature,
        file: filePath,
        line: 0,
        breaking: false,
        confidence: 0.95,
      });
    } else {
      const prev = before.get(key)!;
      if (prev.signature !== info.signature) {
        changes.push({
          kind: 'signature-changed',
          symbol: info.name,
          signature: `${prev.signature}  →  ${info.signature}`,
          file: filePath,
          line: 0,
          breaking: info.kind !== 'class',
          confidence: 0.9,
          detail: 'Declaration signature differs between revisions.',
        });
      }
    }
  }

  for (const [key, info] of before) {
    if (!after.has(key)) {
      const kind =
        info.kind === 'class'
          ? 'class-removed'
          : info.kind === 'export'
            ? 'export-removed'
            : 'function-removed';
      changes.push({
        kind,
        symbol: info.name,
        signature: info.signature,
        file: filePath,
        line: 0,
        breaking: true,
        confidence: 0.95,
        detail: 'Symbol existed before this change but not after.',
      });
    }
  }

  return changes;
}

export function analyzeParsedDiff(parsed: ParsedDiff): DiffAnalysis {
  const changes: StructuralChange[] = [];

  for (const file of parsed.files) {
    const filePath = file.newPath || file.oldPath;
    const ext = extOf(filePath);
    const base = baseOf(filePath);

    if (CONFIG_FILES.has(base) || base.startsWith('.')) {
      changes.push({
        kind: 'config-changed',
        symbol: base,
        file: filePath,
        line: 0,
        breaking: /"(version|dependencies|scripts|exports|main|bin)"\s*:/.test(
          file.rawPatch,
        ),
        confidence: 0.8,
      });
      continue;
    }

    if (DOC_EXT.has(ext)) {
      changes.push({
        kind: 'docs-only',
        symbol: base,
        file: filePath,
        line: 0,
        breaking: false,
        confidence: 0.9,
      });
      continue;
    }

    if (file.isBinary || file.hunks.length === 0) continue;

    const before = beforeSnapshot(file);
    const after = afterSnapshot(file);

    if (JS_EXT.has(ext)) {
      changes.push(
        ...diffSymbols(file, extractJsSymbols(before), extractJsSymbols(after)),
      );
    } else if (
      PY_EXT.has(ext) ||
      GO_EXT.has(ext) ||
      RUST_EXT.has(ext) ||
      JAVA_EXT.has(ext) ||
      C_EXT.has(ext)
    ) {
      changes.push(
        ...diffSymbols(
          file,
          extractGenericSymbols(before, ext),
          extractGenericSymbols(after, ext),
        ),
      );
    } else if (STYLE_EXT.has(ext) || LOCK_EXT.has(ext)) {
      changes.push({
        kind: 'style-only',
        symbol: base,
        file: filePath,
        line: 0,
        breaking: false,
        confidence: 0.7,
      });
    } else {
      changes.push({
        kind: 'unknown',
        symbol: base,
        file: filePath,
        line: 0,
        breaking: false,
        confidence: 0.3,
      });
    }
  }

  const breakingCount = changes.filter((c) => c.breaking).length;
  const languages = detectLanguages(parsed.files);

  // Risk score: breaking changes weigh heaviest, then volume.
  const riskScore = Math.min(
    100,
    breakingCount * 25 +
      Math.min(parsed.totalAdditions + parsed.totalDeletions, 100) * 0.3 +
      parsed.files.length * 2,
  );

  const summary = buildSummary(changes, parsed);

  return { changes, summary, breakingCount, languages, riskScore };
}

function buildSummary(changes: StructuralChange[], parsed: ParsedDiff): string {
  const counts = new Map<string, number>();
  for (const c of changes) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);

  const parts: string[] = [];
  const label: Record<string, string> = {
    'function-added': 'functions added',
    'function-removed': 'functions removed',
    'function-modified': 'functions modified',
    'class-added': 'classes added',
    'class-removed': 'classes removed',
    'class-modified': 'classes modified',
    'export-added': 'exports added',
    'export-removed': 'exports removed',
    'signature-changed': 'signatures changed',
    'api-endpoint-added': 'API endpoints added',
    'api-endpoint-removed': 'API endpoints removed',
    'dependency-added': 'dependencies added',
    'dependency-removed': 'dependencies removed',
    'config-changed': 'config files changed',
    'docs-only': 'docs only',
    'style-only': 'style-only changes',
    unknown: 'other files',
  };
  for (const [kind, n] of counts) {
    if (kind === 'docs-only' || kind === 'style-only' || kind === 'unknown')
      continue;
    parts.push(`${n} ${label[kind] ?? kind}`);
  }
  if (parts.length === 0) parts.push('content-level edits only (no structural changes detected)');

  return (
    `${parsed.files.length} file(s), +${parsed.totalAdditions}/-${parsed.totalDeletions} lines. ` +
    `Structural: ${parts.join(', ')}.`
  );
}
