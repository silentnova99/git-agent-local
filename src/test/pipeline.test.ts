import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff, toLlmPatch } from '../ast/diffParser';
import { analyzeParsedDiff } from '../ast/astAnalyzer';
import { extractJson, fallbackCandidates } from '../llm/promptBuilder';

const SAMPLE_DIFF = `diff --git a/src/math.js b/src/math.js
index 1111111..2222222 100644
--- a/src/math.js
+++ b/src/math.js
@@ -1,6 +1,9 @@
-export function add(a, b) {
-  return a + b;
+export function add(a, b, c = 0) {
+  return a + b + c;
+}
+
+export function multiply(a, b) {
+  return a * b;
 }

 export const VERSION = '1.0.0';
diff --git a/README.md b/README.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/README.md
@@ -0,0 +1,2 @@
+# Demo
+Math helpers.
`;

test('parseUnifiedDiff splits files, hunks and line counts', () => {
  const parsed = parseUnifiedDiff(SAMPLE_DIFF);
  assert.equal(parsed.files.length, 2);
  assert.equal(parsed.files[0]?.newPath, 'src/math.js');
  assert.equal(parsed.files[1]?.isNewFile, true);
  assert.ok(parsed.totalAdditions > 0);
  assert.ok(parsed.totalDeletions > 0);
  assert.equal(parsed.files[0]?.hunks.length, 1);
});

test('analyzeParsedDiff detects signature change, new export, docs', () => {
  const analysis = analyzeParsedDiff(parseUnifiedDiff(SAMPLE_DIFF));
  const kinds = analysis.changes.map((c) => c.kind);
  assert.ok(kinds.includes('signature-changed'));
  assert.ok(kinds.includes('export-added'));
  assert.ok(kinds.includes('docs-only'));

  const sig = analysis.changes.find((c) => c.kind === 'signature-changed');
  assert.equal(sig?.symbol, 'add');
  assert.equal(sig?.breaking, true);
  assert.equal(analysis.breakingCount, 1);
  assert.ok(analysis.languages.includes('javascript/typescript'));
  assert.ok(analysis.riskScore > 0 && analysis.riskScore <= 100);
});

test('analyzeParsedDiff flags removed exports as breaking', () => {
  const diff = `diff --git a/lib.py b/lib.py
--- a/lib.py
+++ b/lib.py
@@ -1,4 +1,2 @@
-def helper(x):
-    return x * 2
-
 def main():
`;
  const analysis = analyzeParsedDiff(parseUnifiedDiff(diff));
  const removed = analysis.changes.find((c) => c.kind === 'function-removed');
  assert.ok(removed, 'expected function-removed');
  assert.equal(removed?.symbol, 'helper');
  assert.equal(removed?.breaking, true);
});

test('toLlmPatch respects byte budget', () => {
  const parsed = parseUnifiedDiff(SAMPLE_DIFF);
  const patch = toLlmPatch(parsed, 300);
  assert.ok(patch.length <= 600, `patch too long: ${patch.length}`);
  assert.match(patch, /File: src\/math\.js/);
});

test('extractJson pulls array from fenced model output', () => {
  const raw = '```json\n[{"message":"feat: x","rationale":"r","score":90}]\n```';
  const out = extractJson<Array<{ message: string }>>(raw);
  assert.ok(Array.isArray(out));
  assert.equal(out?.[0]?.message, 'feat: x');
});

test('extractJson pulls object output', () => {
  const raw = 'Here you go: {"title":"feat: y","summary":"s"} thanks';
  const out = extractJson<{ title: string }>(raw);
  assert.equal(out?.title, 'feat: y');
});

test('fallbackCandidates extracts lines when JSON is broken', () => {
  const raw = 'feat: do the thing\nfix: repair the stuff\n```';
  const candidates = fallbackCandidates(raw, 3);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0]?.message, 'feat: do the thing');
});
