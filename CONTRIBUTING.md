# Contributing to git-agent-local

Thanks for wanting to help! 🎉

## Setup

```bash
git clone https://github.com/silentnova99/git-agent-local
cd git-agent-local
npm install
npm run build
npm link        # puts `git-agent` on your PATH
git-agent doctor
```

## Workflow

1. Fork and create a feature branch from `main`.
2. Make your change with clear, focused commits.
3. Add/extend tests (`npm test`) — the diff parser and AST analyzer are
   pure functions, so they're easy to test.
4. Run `npm run typecheck` (must be clean; `strict` mode is on).
5. Open a PR with a short description of *why*, not just *what*.

## Where to start

Look for issues labeled **good first issue**. Popular ideas:

- Tree-sitter WASM parsing for a new language
- `--dry-run` flag for `commit`
- Per-language risk-score weights
- Snapshot tests against real-world patches
- README translations

## Code conventions

- TypeScript strict mode; no `any` without a comment justifying it.
- No new runtime dependencies without discussion in an issue first —
  keeping `npm i -g` instant is a feature.
- Prompt changes belong in `src/llm/promptBuilder.ts` only.
- Keep everything offline-capable: no network calls except to the
  configured local LLM endpoint.

## Reporting bugs

Open an issue with: your OS, Node version (`node -v`), Ollama version,
model name, the exact command, and output of `git-agent doctor`.
