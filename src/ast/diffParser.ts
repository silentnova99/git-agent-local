/**
 * diffParser — converts raw `git diff` unified output into structured,
 * per-file change blocks ready for AST analysis and LLM prompting.
 */

import type { DiffLine, FileDiff, Hunk, ParsedDiff } from '../types';

const FILE_HEADER_RE =
  /^diff --git a\/(?<old>.+?) b\/(?<new>.+)$/;
const HUNK_RE =
  /^@@ -(?<oldStart>\d+)(?:,(?<oldCount>\d+))? \+(?<newStart>\d+)(?:,(?<newCount>\d+))? @@(?<context>.*)$/;

export function parseUnifiedDiff(raw: string): ParsedDiff {
  const lines = raw.split(/\r?\n/);
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let currentHunk: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const pushCurrent = () => {
    if (!current) return;
    if (currentHunk) current.hunks.push(currentHunk);
    currentHunk = null;
    current.rawPatch = current.hunks
      .map((h) => {
        const body = h.lines
          .map((l) =>
            l.type === 'add'
              ? `+${l.content}`
              : l.type === 'del'
                ? `-${l.content}`
                : ` ${l.content}`,
          )
          .join('\n');
        return `${h.header}\n${body}`;
      })
      .join('\n');
    current.additions = current.hunks.reduce(
      (n, h) => n + h.lines.filter((l) => l.type === 'add').length,
      0,
    );
    current.deletions = current.hunks.reduce(
      (n, h) => n + h.lines.filter((l) => l.type === 'del').length,
      0,
    );
    files.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.startsWith('diff --git ')) {
      pushCurrent();
      const match = FILE_HEADER_RE.exec(line);
      current = {
        oldPath: match?.groups?.old ?? '',
        newPath: match?.groups?.new ?? '',
        isBinary: false,
        isDeleted: false,
        isNewFile: false,
        isRename: false,
        hunks: [],
        rawPatch: '',
        additions: 0,
        deletions: 0,
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith('new file mode')) {
      current.isNewFile = true;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.isDeleted = true;
      continue;
    }
    if (line.startsWith('rename from') || line.startsWith('rename to')) {
      current.isRename = true;
      const to = line.startsWith('rename to ')
        ? line.slice('rename to '.length)
        : undefined;
      if (to) current.newPath = to;
      continue;
    }
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      current.isBinary = true;
      continue;
    }
    if (line.startsWith('index ') || line.startsWith('similarity index')) {
      continue;
    }

    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch?.groups) {
      if (currentHunk) current.hunks.push(currentHunk);
      oldLine = Number(hunkMatch.groups.oldStart);
      newLine = Number(hunkMatch.groups.newStart);
      currentHunk = {
        header: line,
        oldStart: oldLine,
        oldCount: Number(hunkMatch.groups.oldCount ?? 1),
        newStart: newLine,
        newCount: Number(hunkMatch.groups.newCount ?? 1),
        lines: [],
      };
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith('\\')) continue; // "\ No newline at end of file"

    const dl: DiffLine =
      line.startsWith('+')
        ? { type: 'add', content: line.slice(1), newLine: newLine++ }
        : line.startsWith('-')
          ? { type: 'del', content: line.slice(1), oldLine: oldLine++ }
          : {
              type: 'context',
              content: line.startsWith(' ') ? line.slice(1) : line,
              oldLine: oldLine++,
              newLine: newLine++,
            };
    currentHunk.lines.push(dl);
  }
  pushCurrent();

  return {
    files,
    totalAdditions: files.reduce((n, f) => n + f.additions, 0),
    totalDeletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}

/**
 * Render a structured ParsedDiff back to a compact unified diff for LLM
 * consumption, with non-code noise pruned and oversized hunks truncated.
 */
export function toLlmPatch(parsed: ParsedDiff, maxBytes: number): string {
  const parts: string[] = [];
  let budget = maxBytes;

  for (const file of parsed.files) {
    if (file.isBinary) {
      const header = `Binary file: ${file.newPath}`;
      if (header.length < budget) {
        parts.push(header);
        budget -= header.length;
      }
      continue;
    }
    const header = `File: ${file.newPath}${file.isNewFile ? ' (new)' : ''}${file.isDeleted ? ' (deleted)' : ''}`;
    let body = '';
    for (const hunk of file.hunks) {
      body += `${hunk.header}\n`;
      for (const l of hunk.lines) {
        const prefix =
          l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
        body += `${prefix}${l.content}\n`;
      }
    }
    const block = `${header}\n${body}`;
    if (block.length <= budget) {
      parts.push(block);
      budget -= block.length;
    } else if (budget > 200) {
      parts.push(`${block.slice(0, budget)}\n... [diff truncated]`);
      budget = 0;
      break;
    } else {
      parts.push('... [remaining files truncated: diff exceeded size budget]');
      break;
    }
  }

  return parts.join('\n');
}
