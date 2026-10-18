/**
 * Shared domain types for git-agent-local.
 */

export interface OllamaModel {
  name: string;
  size: number;
  parameter_size?: string;
  quantization_level?: string;
}

export interface GenerateOptions {
  model: string;
  prompt: string;
  system?: string;
  temperature?: number;
  topP?: number;
  numCtx?: number;
  maxTokens?: number;
  stream?: boolean;
  abortSignal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  evalCount: number;
  evalDurationMs: number;
  tokensPerSecond: number;
  done: boolean;
}

export type ChangeKind =
  | 'function-added'
  | 'function-removed'
  | 'function-modified'
  | 'class-added'
  | 'class-removed'
  | 'class-modified'
  | 'export-added'
  | 'export-removed'
  | 'signature-changed'
  | 'api-endpoint-added'
  | 'api-endpoint-removed'
  | 'dependency-added'
  | 'dependency-removed'
  | 'config-changed'
  | 'docs-only'
  | 'style-only'
  | 'unknown';

export interface StructuralChange {
  kind: ChangeKind;
  symbol: string;
  signature?: string;
  file: string;
  line: number;
  breaking: boolean;
  confidence: number; // 0..1
  detail?: string;
}

export interface DiffLine {
  type: 'context' | 'add' | 'del' | 'meta';
  content: string;
  oldLine?: number;
  newLine?: number;
}

export interface Hunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface FileDiff {
  oldPath: string;
  newPath: string;
  isBinary: boolean;
  isDeleted: boolean;
  isNewFile: boolean;
  isRename: boolean;
  hunks: Hunk[];
  rawPatch: string;
  additions: number;
  deletions: number;
}

export interface ParsedDiff {
  files: FileDiff[];
  totalAdditions: number;
  totalDeletions: number;
}

export interface DiffAnalysis {
  changes: StructuralChange[];
  summary: string;
  breakingCount: number;
  languages: string[];
  riskScore: number; // 0..100
}

export interface CommitCandidate {
  message: string;
  rationale: string;
  score: number;
}

export interface AgentConfig {
  baseUrl: string;
  model: string;
  fallbackModels: string[];
  temperature: number;
  maxTokens: number;
  numCtx: number;
  timeoutMs: number;
  conventionalCommits: boolean;
  maxDiffBytes: number;
}

export interface ScanOptions {
  staged?: boolean;
  ref?: string;
  paths?: string[];
}

export type OutputFormat = 'pretty' | 'json' | 'plain';
