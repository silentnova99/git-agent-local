/**
 * git-agent CLI entry point.
 *
 * Commands:
 *   git-agent commit        Generate + interactively stage commit message
 *   git-agent scan          AST-analyze staged diff, no LLM required
 *   git-agent pr            Draft a PR title/description
 *   git-agent explain       Explain the current staged change
 *   git-agent doctor        Diagnose local setup (git, Ollama, models)
 *   git-agent config        Show or set configuration
 */

import { Command, Option } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import * as path from 'node:path';

import { OllamaClient, OllamaError } from '../llm/ollamaClient';
import { parseUnifiedDiff, toLlmPatch } from '../ast/diffParser';
import { analyzeParsedDiff } from '../ast/astAnalyzer';
import {
  buildCommitPrompt,
  buildExplainPrompt,
  buildPrPrompt,
  extractJson,
  fallbackCandidates,
} from '../llm/promptBuilder';
import * as git from '../git/gitService';
import { loadConfig, writeUserConfig, userConfigPath, DEFAULT_CONFIG } from '../config';
import type {
  AgentConfig,
  CommitCandidate,
  DiffAnalysis,
  OutputFormat,
  ParsedDiff,
} from '../types';

const pkgVersion = '0.1.0';

function fail(message: string, hint?: string): never {
  console.error(chalk.red(`✖ ${message}`));
  if (hint) console.error(chalk.yellow(`  ${hint}`));
  process.exit(1);
}

async function requireRepo(cwd: string): Promise<string> {
  if (!(await git.isRepo(cwd))) {
    fail('Not a git repository.', 'Run inside a repo, or: git init');
  }
  return git.repoRoot(cwd);
}

async function collectDiff(
  cwd: string,
  opts: { staged: boolean; ref?: string; paths?: string[] },
): Promise<{ raw: string; parsed: ParsedDiff; analysis: DiffAnalysis; label: string }> {
  let raw: string;
  let label: string;
  if (opts.ref) {
    raw = await git.diffAgainstRef(cwd, opts.ref, opts.paths);
    label = `HEAD vs ${opts.ref}`;
  } else if (opts.staged) {
    raw = await git.stagedDiff(cwd, opts.paths);
    label = 'staged changes';
  } else {
    raw = await git.stagedDiff(cwd, opts.paths);
    if (raw.trim().length === 0) {
      raw = await git.unstagedDiff(cwd, opts.paths);
      label = 'working tree changes';
    } else {
      label = 'staged changes';
    }
  }
  if (raw.trim().length === 0) {
    fail('No diff found to analyze.', 'Stage changes with: git add <files>');
  }
  const parsed = parseUnifiedDiff(raw);
  const analysis = analyzeParsedDiff(parsed);
  return { raw, parsed, analysis, label };
}

function makeClient(cfg: AgentConfig): OllamaClient {
  return new OllamaClient(cfg.baseUrl, cfg.timeoutMs);
}

async function resolveModel(
  client: OllamaClient,
  cfg: AgentConfig,
  spinner: ora.Ora,
): Promise<string> {
  const candidates = [cfg.model, ...cfg.fallbackModels];
  try {
    const model = await client.resolveModel(candidates);
    if (model !== cfg.model) {
      spinner.info(
        chalk.yellow(`Model "${cfg.model}" not found — using "${model}" instead.`),
      );
    }
    return model;
  } catch (err) {
    spinner.stop();
    throw err;
  }
}

function printAnalysis(analysis: DiffAnalysis, label: string): void {
  console.log('');
  console.log(chalk.bold.cyan(`◆ AST analysis — ${label}`));
  console.log(chalk.gray(`  ${analysis.summary}`));
  if (analysis.languages.length) {
    console.log(chalk.gray(`  Languages: ${analysis.languages.join(', ')}`));
  }
  console.log(
    chalk.gray(
      `  Risk score: ${analysis.riskScore}/100` +
        (analysis.breakingCount
          ? chalk.red(` — ${analysis.breakingCount} breaking change(s)`)
          : ''),
    ),
  );
  if (analysis.changes.length) {
    console.log('');
    for (const c of analysis.changes.slice(0, 30)) {
      const tag = c.breaking
        ? chalk.bgRed.white(' BREAKING ')
        : chalk.bgGreen.black(` ${c.kind} `);
      const sig = c.signature ? chalk.gray(` — ${c.signature}`) : '';
      console.log(`  ${tag} ${chalk.bold(c.symbol)}${sig}`);
      console.log(chalk.gray(`     ${c.file}${c.line ? `:${c.line}` : ''}`));
    }
    if (analysis.changes.length > 30) {
      console.log(chalk.gray(`  … and ${analysis.changes.length - 30} more`));
    }
  }
  console.log('');
}

// ---------------------------------------------------------------------------

export async function run(argv: string[]): Promise<void> {
  const program = new Command();

  program
    .name('git-agent')
    .description(
      'Zero-API, offline, AST-aware AI git assistant powered by local LLMs (Ollama).',
    )
    .version(pkgVersion);

  const addCommon = (cmd: Command): Command =>
    cmd
      .option('-C, --cwd <dir>', 'working directory', process.cwd())
      .option('--model <name>', 'Ollama model to use')
      .option('--url <url>', 'Ollama base URL')
      .option('--json', 'machine-readable JSON output')
      .addOption(
        new Option('--no-conventional', 'disable Conventional Commits format').conflicts(
          'conventional',
        ),
      );

  addCommon(
    program
      .command('scan')
      .description('AST-analyze the current diff (no LLM call)'),
  )
    .option('-s, --staged', 'analyze only staged changes', true)
    .option('--ref <ref>', 'diff against a git ref (e.g. main)')
    .action(async (opts: Record<string, unknown>) => {
      const cwd = String(opts.cwd);
      const cfg = loadConfig(cwd, configOverrides(opts));
      const repo = await requireRepo(cwd);
      const { analysis, label } = await collectDiff(repo, {
        staged: Boolean(opts.staged),
        ref: opts.ref as string | undefined,
      });
      if (opts.json) {
        console.log(JSON.stringify(analysis, null, 2));
        return;
      }
      printAnalysis(analysis, label);
    });

  addCommon(
    program
      .command('commit')
      .description('Generate commit message candidates from the staged diff')
  )
    .option('-s, --staged', 'use staged changes (default)', true)
    .option('--ref <ref>', 'diff against a git ref')
    .option('-n, --count <n>', 'number of candidates', '3')
    .option('-y, --yes', 'skip prompts; print the top candidate only')
    .option('--no-commit', 'do not run git commit, just print the message')
    .action(async (opts: Record<string, unknown>) => {
      const cwd = String(opts.cwd);
      const cfg = loadConfig(cwd, configOverrides(opts));
      const repo = await requireRepo(cwd);

      const diffSpinner = ora('Collecting diff…').start();
      const { parsed, analysis, label } = await collectDiff(repo, {
        staged: Boolean(opts.staged),
        ref: opts.ref as string | undefined,
      }).catch((err: Error) => {
        diffSpinner.fail(err.message);
        process.exit(1);
      });
      diffSpinner.succeed(
        `Diff ready: ${parsed.files.length} file(s), +${parsed.totalAdditions}/-${parsed.totalDeletions}`,
      );

      if (!opts.json) printAnalysis(analysis, label);

      const llm = ora('Connecting to local Ollama…').start();
      let client: OllamaClient;
      let model: string;
      try {
        client = makeClient(cfg);
        if (!(await client.isAlive())) {
          llm.fail('Ollama is not reachable');
          fail(
            `Cannot reach ${cfg.baseUrl}`,
            'Start it with: ollama serve   (then: ollama pull ' + cfg.model + ')',
          );
        }
        model = await resolveModel(client, cfg, llm);
        llm.succeed(`Model: ${chalk.bold(model)}`);
      } catch (err) {
        llm.fail('Model resolution failed');
        fail(
          err instanceof OllamaError ? err.message : String(err),
        );
      }

      const branch = await git.currentBranch(repo);
      const recent = await git.lastCommits(repo, 15);
      const count = Math.max(1, Math.min(10, Number(opts.count) || 3));
      const patch = toLlmPatch(parsed, cfg.maxDiffBytes);

      const gen = ora({
        text: 'Generating commit candidates (100% offline)…',
        spinner: 'dots12',
      }).start();

      const candidates = await generateCandidates({
        client,
        model,
        cfg,
        patch,
        analysis,
        branch,
        recent,
        count,
        conventional: opts.conventional !== false,
        onToken: (frag) => {
          gen.text = `Generating commit candidates (100% offline)… ${chalk.gray(
            frag.replace(/\n/g, ' ').slice(0, 48),
          )}`;
        },
      }).catch((err: Error) => {
        gen.fail(err.message);
        fail(
          err.message,
          err instanceof OllamaError ? 'Check `ollama list` and try again.' : undefined,
        );
      });
      gen.succeed(`Generated ${candidates.length} candidate(s)`);

      if (opts.json) {
        console.log(JSON.stringify({ analysis, candidates }, null, 2));
        return;
      }

      let chosen = candidates[0]!;

      if (opts.y || opts.yes) {
        chosen = candidates[0]!;
      } else {
        const { selected } = await inquirer.prompt<{
          selected: string;
        }>([
          {
            type: 'list',
            name: 'selected',
            message: 'Pick a commit message:',
            pageSize: Math.min(10, candidates.length + 1),
            choices: [
              ...candidates.map((c, i) => ({
                name: `${chalk.bold(c.message)}\n     ${chalk.gray(
                  `${c.score}/100 — ${c.rationale}`,
                )}`,
                value: String(i),
                short: c.message,
              })),
              {
                name: chalk.cyan('✎ Write my own message'),
                value: 'custom',
                short: 'custom',
              },
              {
                name: chalk.gray('✖ Cancel'),
                value: 'cancel',
                short: 'cancel',
              },
            ],
          },
        ]);

        if (selected === 'cancel') {
          console.log(chalk.yellow('Cancelled. Nothing was committed.'));
          return;
        }
        if (selected === 'custom') {
          const { custom } = await inquirer.prompt<{ custom: string }>([
            {
              type: 'editor',
              name: 'custom',
              message: 'Commit message:',
              default: candidates[0]?.message ?? '',
              validate: (v: string) =>
                v.trim().length > 0 || 'Message cannot be empty',
            },
          ]);
          chosen = {
            message: custom.trim(),
            rationale: 'User-authored.',
            score: 100,
          };
        } else {
          chosen = candidates[Number(selected)]!;
        }
      }

      if (opts.commit === false) {
        console.log(`\n${chalk.bold.green(chosen.message)}\n`);
        return;
      }

      const status = await git.statusPorcelain(repo);
      if (!status.trim()) {
        fail('Nothing staged to commit.', 'Stage files first: git add -A');
      }

      console.log(`\n${chalk.bold.green(chosen.message)}\n`);
      const commitSpinner = ora('Committing…').start();
      try {
        const out = await git.commit(repo, chosen.message);
        commitSpinner.succeed('Committed.');
        console.log(chalk.gray(out.trim()));
      } catch (err) {
        commitSpinner.fail('git commit failed');
        fail(err instanceof Error ? err.message : String(err));
      }
    });

  addCommon(
    program.command('pr').description('Draft a PR title and description')
  )
    .option('--base <branch>', 'base branch', 'main')
    .option('--ref <ref>', 'diff against a git ref')
    .action(async (opts: Record<string, unknown>) => {
      const cwd = String(opts.cwd);
      const cfg = loadConfig(cwd, configOverrides(opts));
      const repo = await requireRepo(cwd);
      const ref = (opts.ref as string | undefined) ?? String(opts.base);

      const spinner = ora('Analyzing diff…').start();
      const { parsed, analysis } = await collectDiff(repo, {
        staged: false,
        ref,
      }).catch((err: Error) => {
        spinner.fail(err.message);
        process.exit(1);
      });

      let model: string;
      let client: OllamaClient;
      try {
        client = makeClient(cfg);
        if (!(await client.isAlive())) throw new OllamaError(`Cannot reach ${cfg.baseUrl}`);
        model = await resolveModel(client, cfg, spinner);
      } catch (err) {
        spinner.fail(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      spinner.start('Drafting PR description…');
      const branch = await git.currentBranch(repo);
      const patch = toLlmPatch(parsed, cfg.maxDiffBytes);
      const res = await client.generate({
        model,
        prompt: buildPrPrompt({
          title: `Update from ${branch}`,
          patch,
          analysis,
          branch,
          baseBranch: String(opts.base),
        }),
        temperature: 0.3,
        maxTokens: cfg.maxTokens,
      }).catch((err: Error) => {
        spinner.fail(err.message);
        process.exit(1);
      });
      spinner.stop();

      const parsedJson = extractJson<{
        title: string;
        summary: string;
        changes: string[];
        testing: string[];
        breaking: string;
      }>(res.text);

      if (opts.json) {
        console.log(JSON.stringify(parsedJson ?? { raw: res.text }, null, 2));
        return;
      }

      if (!parsedJson) {
        console.log(res.text);
        return;
      }

      console.log('');
      console.log(chalk.bold.cyan(`# ${parsedJson.title}`));
      console.log('');
      console.log(parsedJson.summary);
      if (parsedJson.changes?.length) {
        console.log('\n' + chalk.bold('## Changes'));
        for (const c of parsedJson.changes) console.log(`- ${c}`);
      }
      if (parsedJson.testing?.length) {
        console.log('\n' + chalk.bold('## Testing'));
        for (const t of parsedJson.testing) console.log(`- ${t}`);
      }
      if (parsedJson.breaking) {
        console.log('\n' + chalk.bgRed.white('## Breaking changes'));
        console.log(parsedJson.breaking);
      }
      console.log('');
      console.log(chalk.gray(`model=${model} · ${res.evalCount} tokens · ${res.tokensPerSecond.toFixed(1)} tok/s`));
    });

  addCommon(
    program.command('explain').description('Explain the current staged change')
  )
    .option('--ref <ref>', 'diff against a git ref')
    .action(async (opts: Record<string, unknown>) => {
      const cwd = String(opts.cwd);
      const cfg = loadConfig(cwd, configOverrides(opts));
      const repo = await requireRepo(cwd);

      const spinner = ora('Analyzing diff…').start();
      const { parsed, analysis } = await collectDiff(repo, {
        staged: true,
        ref: opts.ref as string | undefined,
      }).catch((err: Error) => {
        spinner.fail(err.message);
        process.exit(1);
      });

      let model: string;
      let client: OllamaClient;
      try {
        client = makeClient(cfg);
        if (!(await client.isAlive())) throw new OllamaError(`Cannot reach ${cfg.baseUrl}`);
        model = await resolveModel(client, cfg, spinner);
      } catch (err) {
        spinner.fail(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      spinner.start('Explaining (offline)…');
      const patch = toLlmPatch(parsed, cfg.maxDiffBytes);
      const res = await client
        .generate({
          model,
          prompt: buildExplainPrompt({ patch, analysis }),
          temperature: 0.2,
          maxTokens: cfg.maxTokens,
        })
        .catch((err: Error) => {
          spinner.fail(err.message);
          process.exit(1);
        });
      spinner.succeed('Done.');
      console.log('');
      console.log(res.text.trim());
      console.log('');
      if (opts.json === undefined) {
        console.log(chalk.gray(`model=${model} · ${res.tokensPerSecond.toFixed(1)} tok/s`));
      }
    });

  program
    .command('doctor')
    .description('Diagnose local environment: git, Ollama, models')
    .option('-C, --cwd <dir>', 'working directory', process.cwd())
    .option('--url <url>', 'Ollama base URL')
    .action(async (opts: Record<string, unknown>) => {
      const cfg = loadConfig(String(opts.cwd), { baseUrl: opts.url as string | undefined });
      let ok = true;

      console.log(chalk.bold('\n git-agent doctor \n'));

      const inRepo = await git.isRepo(String(opts.cwd));
      console.log(
        `${inRepo ? chalk.green('✔') : chalk.red('✖')} git repository`,
        inRepo ? chalk.gray(await git.currentBranch(String(opts.cwd))) : '',
      );
      if (!inRepo) ok = false;

      const client = makeClient(cfg);
      const alive = await client.isAlive();
      console.log(
        `${alive ? chalk.green('✔') : chalk.red('✖')} Ollama at ${cfg.baseUrl}`,
      );
      if (!alive) {
        ok = false;
        console.log(
          chalk.yellow('  → Start it: ollama serve'),
        );
      } else {
        const version = await client.version().catch(() => 'unknown');
        console.log(chalk.gray(`  version ${version}`));
        const models = await client.listModels().catch(() => []);
        if (models.length === 0) {
          console.log(chalk.yellow('  → No models installed. Try: ollama pull llama3.1'));
          ok = false;
        } else {
          console.log(chalk.green(`  ✔ ${models.length} model(s) installed`));
          for (const m of models.slice(0, 8)) {
            const preferred =
              m.name === cfg.model || cfg.fallbackModels.some((f) => m.name.startsWith(f));
            console.log(
              `    ${preferred ? chalk.cyan('•') : chalk.gray('·')} ${m.name}` +
                chalk.gray(
                  ` ${m.parameter_size ?? ''} ${m.quantization_level ?? ''}`.trim(),
                ),
            );
          }
          try {
            await client.resolveModel([cfg.model, ...cfg.fallbackModels]);
            console.log(chalk.green(`  ✔ preferred model "${cfg.model}" (or fallback) available`));
          } catch (err) {
            console.log(chalk.yellow(`  → ${err instanceof Error ? err.message.split('\n')[0] : ''}`));
          }
        }
      }

      console.log(
        `\nConfig sources: ${chalk.gray(loadConfig(String(opts.cwd)).sources.join(' → '))}`,
      );
      console.log(ok ? chalk.green('Environment looks good.\n') : chalk.yellow('Fix the items above.\n'));
      process.exit(ok ? 0 : 1);
    });

  const configCmd = program
    .command('config')
    .description('Show or update configuration');

  configCmd
    .command('show')
    .description('Print effective configuration')
    .option('-C, --cwd <dir>', 'working directory', process.cwd())
    .action((opts: Record<string, unknown>) => {
      const cfg = loadConfig(String(opts.cwd));
      const { sources, ...rest } = cfg;
      console.log(JSON.stringify(rest, null, 2));
      console.error(chalk.gray(`sources: ${sources.join(' → ')}`));
      console.error(chalk.gray(`user file: ${userConfigPath()}`));
    });

  configCmd
    .command('set <key> <value>')
    .description('Set a user-level configuration value')
    .action((key: string, value: string) => {
      const allowed = Object.keys(DEFAULT_CONFIG);
      if (!allowed.includes(key)) {
        fail(`Unknown key "${key}".`, `Valid keys: ${allowed.join(', ')}`);
      }
      let parsedValue: unknown = value;
      const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>;
      if (typeof defaults[key] === 'number') {
        parsedValue = Number(value);
        if (Number.isNaN(parsedValue)) fail(`"${key}" must be a number.`);
      } else if (typeof defaults[key] === 'boolean') {
        parsedValue = value === 'true' || value === '1';
      } else if (Array.isArray(defaults[key])) {
        parsedValue = value.split(',').map((s) => s.trim());
      }
      const file = writeUserConfig({ [key]: parsedValue } as Partial<AgentConfig>);
      console.log(chalk.green(`✔ ${key} = ${value}`));
      console.log(chalk.gray(`  written to ${file}`));
    });

  program.configureOutput({
    outputError: (str, write) => write(chalk.red(str)),
  });

  await program.parseAsync(argv);
}

function configOverrides(opts: Record<string, unknown>): Partial<AgentConfig> {
  const out: Partial<AgentConfig> = {};
  if (typeof opts.model === 'string') out.model = opts.model;
  if (typeof opts.url === 'string') out.baseUrl = opts.url;
  if (opts.conventional === false) out.conventionalCommits = false;
  return out;
}

interface GenerateInput {
  client: OllamaClient;
  model: string;
  cfg: AgentConfig;
  patch: string;
  analysis: DiffAnalysis;
  branch: string;
  recent: string[];
  count: number;
  conventional: boolean;
  onToken: (fragment: string) => void;
}

async function generateCandidates(input: GenerateInput): Promise<CommitCandidate[]> {
  const prompt = buildCommitPrompt({
    patch: input.patch,
    analysis: input.analysis,
    branch: input.branch,
    recentMessages: input.recent,
    conventional: input.conventional,
    candidateCount: input.count,
  });

  const result = await input.client.generateStream(
    {
      model: input.model,
      prompt,
      system:
        'You are a precise git commit message generator. You output valid JSON only, never markdown, never explanations.',
      temperature: input.cfg.temperature,
      maxTokens: input.cfg.maxTokens,
      numCtx: input.cfg.numCtx,
    },
    input.onToken,
  );

  const parsed = extractJson<CommitCandidate[]>(result.text);
  const valid = Array.isArray(parsed)
    ? parsed
        .filter(
          (c): c is CommitCandidate =>
            !!c && typeof c.message === 'string' && c.message.trim().length > 0,
        )
        .map((c) => ({
          message: c.message.trim(),
          rationale: typeof c.rationale === 'string' ? c.rationale : '',
          score: typeof c.score === 'number' ? c.score : 50,
        }))
    : [];

  if (valid.length > 0) {
    return valid.sort((a, b) => b.score - a.score).slice(0, input.count);
  }
  return fallbackCandidates(result.text, input.count);
}
