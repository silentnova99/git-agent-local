/**
 * promptBuilder — constructs deterministic, structured prompts for the local
 * model. Prompts are intentionally explicit: small local models follow
 * rigid output formats far better than open-ended instructions.
 */

import type { CommitCandidate, DiffAnalysis } from '../types';

export function buildCommitPrompt(input: {
  patch: string;
  analysis: DiffAnalysis;
  branch: string;
  recentMessages: string[];
  conventional: boolean;
  candidateCount: number;
}): string {
  const historySection = input.recentMessages.length
    ? `Recent commit subjects in this repo (match their style):\n${input.recentMessages
        .map((m) => `- ${m}`)
        .join('\n')}\n\n`
    : '';

  const breakingSection = input.analysis.breakingCount
    ? `IMPORTANT: ${input.analysis.breakingCount} BREAKING change(s) detected at the symbol level. Flag them with a "!" and mention the impact in the body.\n\n`
    : '';

  const format = input.conventional
    ? `Return EXACTLY ${input.candidateCount} candidate commit messages, each as a single JSON object inside one JSON array, and nothing else:

[
  {
    "message": "<type>(<scope>): <subject>",
    "rationale": "<one sentence explaining the choice>",
    "score": <integer 0-100>
  }
]

Rules:
- Use Conventional Commits: type in feat|fix|docs|refactor|perf|test|build|ci|chore|style|revert.
- Subject line <= 72 characters, imperative mood, no trailing period.
- Scope: derive from the most-affected directory or package, omit if unclear.
- Add a blank line then a wrapped body (<= 72 chars/line) ONLY when the diff is non-trivial.
- If changes are breaking, use "type(scope)!: ..." and add "BREAKING CHANGE: ..." in the body.
- Do NOT invent files or symbols that are not in the diff.
- Output ONLY the JSON array. No markdown fences, no commentary.`
    : `Return EXACTLY ${input.candidateCount} candidate commit messages as a JSON array of objects with keys "message", "rationale", "score" (0-100), and nothing else. Subject <= 72 chars, imperative mood, no trailing period. Output ONLY the JSON array.`;

  return `You are an expert software engineer writing a git commit message for a repository.

## Repository context
Branch: ${input.branch}
${historySection}## Structural analysis (from AST of the diff)
${input.analysis.summary}
Languages: ${input.analysis.languages.join(', ') || 'unknown'}
${breakingSection}
## Unified diff
\`\`\`diff
${input.patch}
\`\`\`

## Task
${format}`;
}

export function buildPrPrompt(input: {
  title: string;
  patch: string;
  analysis: DiffAnalysis;
  branch: string;
  baseBranch: string;
}): string {
  return `You are writing a GitHub pull request description.

Branch: ${input.branch} -> ${input.baseBranch}
Working title: ${input.title}

Structural analysis:
${input.analysis.summary}
Breaking changes detected: ${input.analysis.breakingCount}

Diff:
\`\`\`diff
${input.patch}
\`\`\`

Return ONLY a JSON object with these keys and nothing else:
{
  "title": "<= 60 chars, imperative",
  "summary": "2-4 sentence overview",
  "changes": ["bullet", "bullet"],
  "testing": ["bullet describing how it was verified"],
  "breaking": "<empty string if none, else what breaks and how to migrate>"
}

No markdown fences. No commentary.`;
}

export function buildExplainPrompt(input: {
  patch: string;
  analysis: DiffAnalysis;
}): string {
  return `Explain the following code change to a senior engineer, focusing on WHAT structurally changed (functions/classes/APIs) and WHY it matters. Be concise: at most 6 bullet points, plain text, no preamble.

Structural analysis: ${input.analysis.summary}

Diff:
\`\`\`diff
${input.patch}
\`\`\``;
}

/** Extract the first parsable JSON array/object from model output. */
export function extractJson<T>(raw: string): T | null {
  const cleaned = raw
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  const arrayStart = cleaned.indexOf('[');
  const objectStart = cleaned.indexOf('{');
  let start = -1;
  if (arrayStart !== -1 && (objectStart === -1 || arrayStart < objectStart)) {
    start = arrayStart;
  } else if (objectStart !== -1) {
    start = objectStart;
  }
  if (start === -1) return null;

  const open = cleaned[start]!;
  const close = open === '[' ? ']' : '}';
  const end = cleaned.lastIndexOf(close);
  if (end <= start) return null;

  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** Fallback: turn a raw model response into one candidate when JSON parsing fails. */
export function fallbackCandidates(raw: string, count: number): CommitCandidate[] {
  const lines = raw
    .split('\n')
    .map((l) => l.replace(/^[\s>*-]+/, '').trim())
    .filter((l) => l.length > 0 && !l.startsWith('```'));

  const messages = lines
    .filter((l) => l.length <= 120)
    .slice(0, count);

  return messages.map((message, i) => ({
    message,
    rationale: 'Extracted from raw model output (JSON parse failed).',
    score: Math.max(10, 70 - i * 10),
  }));
}
