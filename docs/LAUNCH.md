# 🚀 Launch Playbook — git-agent-local

Copy-paste-ready launch copy for day 1. Adjust `[links]` before posting.

---

## 1. Show HN

**Title options (pick one, ≤ 80 chars):**

```
git-agent-local: offline AI commit messages using local LLMs, no API keys
Show HN: I built a git agent that runs 100% on your machine (Ollama)
Show HN: AST-aware git assistant – local LLM writes your commit messages
```

**Launch comment template (post immediately after submission):**

```
Hi HN – author here.

I got tired of two things: paying per token to have an LLM write "chore:
update stuff", and cloud tools that ship my uncommitted diff to someone
else's server.

git-agent-local is a CLI that does three things offline:

1. Parses `git diff --cached` into a real syntax tree (@babel/parser for
   JS/TS, language-aware scanners elsewhere) instead of feeding raw text
   to the model. It detects added/removed functions, changed signatures,
   removed exports, and marks them BREAKING up front.
2. Builds a rigid JSON-schema prompt so a 7B model on my laptop produces
   reliable Conventional Commit candidates (streamed, ~15 tok/s on CPU).
3. Lets me arrow-key pick one and commits. `git-agent doctor` diagnoses
   the whole stack.

Interesting design bits:
- The prompt includes the repo's last 15 commit subjects as style
  context, so messages match your house style.
- Diff is budget-truncated (24KB default) before it hits num_ctx; the
  structural summary is always included in full so no semantic signal is
  lost when truncation kicks in.
- Model fallback chain: llama3.1 -> qwen2.5-coder -> deepseek-coder ->
  codellama -> llama3, resolved against `ollama list` at runtime.

Limits I'll be honest about: AST analysis is deep for JS/TS and
heuristic for Python/Go/Rust/Java/C++ (line-level declaration scanning).
Non-JSON model output falls back to line extraction. There's no
tree-sitter yet – it's on the roadmap as WASM so we keep zero native deps.

Curious what HN thinks: is "local-first git assistant" a category people
want, or is this a solution looking for a problem? Also interested in
whether you'd trust an LLM to make the commit *for you* vs. just suggest.
```

---

## 2. Reddit

### r/LocalLLaMA

**Title:**

```
Built git-agent-local: a git CLI that writes commit messages with a local LLM – zero API keys, AST-aware diffs, works in the terminal
```

**Body:**

```
Repo: [LINK]

I wanted commit-message generation without sending diffs to OpenAI. This
CLI talks only to localhost:11434 (Ollama) – or LM Studio, or anything
Ollama-compatible.

What makes it different from "pipe git diff into an LLM":

- It parses the diff into a syntax tree first. For JS/TS it uses a real
  AST parser and diffs declarations between revisions: added/removed
  functions, changed signatures, removed exports. Signature changes get
  flagged BREAKING before the model sees them.
- Structured JSON output prompts (not "please write a commit") – this is
  what makes 7B models actually usable for this. I get 3 ranked
  candidates with rationales.
- Your repo's recent 15 commit subjects are injected so it matches your
  style.
- Streaming + token/s stats in the TTY.

Tested on qwen2.5-coder:7b (Q4_K_M), ~14 tok/s on my CPU. Anything
bigger will fly on a GPU box.

    npm i -g git-agent-local
    git add -A && git-agent commit

`git-agent scan` works with no LLM at all – pure AST analysis of your
diff, including a 0-100 risk score.

Feedback wanted: which model gives you the best commit messages? And
would you want a `git-agent review` mode for offline PR review?
```

### r/programming

**Title:**

```
I built an offline git assistant that analyzes your diff's AST before asking a local LLM to write the commit message
```

**Body:**

```
[LINK]

The interesting engineering problem: raw diffs are noisy and small local
models hallucinate. So instead of pasting the diff, the tool:

1. Parses `git diff --cached` into per-file hunks
2. Reconstructs before/after snapshots and parses both with a real
   parser (Babel for JS/TS)
3. Diffs the symbol tables: functions, classes, methods, exports,
   framework routes (app.get/router.post...)
4. Feeds the model a compact structural summary + budgeted patch with a
   strict JSON schema

Result: correct Conventional Commits like
`feat(index.js): add optional third parameter to add function` from a
7B model, fully offline, ~10s from staging to commit.

Only runtime deps are the prompt/UI libs – no native compilation, no
Python. `npm i -g git-agent-local`, needs Ollama running.

Curious whether others would use this, and which languages you'd want
first-class AST support for (currently deep for JS/TS, heuristic for
Python/Go/Rust/Java/C++).
```

### r/node (r/nodejs)

**Title:**

```
git-agent-local: npm-installable CLI that writes your git commits with a local LLM (Ollama), with Babel-powered AST diff analysis
```

**Body:**

```
[LINK]

    npm i -g git-agent-local
    git-agent doctor

Node >= 18, TypeScript, CommonJS build. Commands: commit, scan, explain,
pr, doctor, config. The AST layer uses @babel/parser to diff declarations
between revisions of every changed JS/TS file and flags breaking changes
(signature edits, removed exports).

Zero API keys – everything goes to localhost. `--json` output on every
command for scripting. Happy for PRs, especially around the diff analyzer
(Good First Issues are labeled).
```

---

## 3. X / Twitter

**Launch thread — post 1 of 2:**

```
🔒 Your diffs never leave your machine.

Introducing git-agent-local — an AI git agent that writes your commit
messages with a LOCAL LLM.

• 100% offline, zero API keys
• AST-aware: detects breaking changes before the LLM even runs
• `npm i -g git-agent-local` and go

Demo 🧵👇

#LocalLLM #Ollama #DevTools
```

**Post 2 (the demo/gif post):**

```
git add -A
git-agent commit

→ AST analyzer: 1 signature change (BREAKING), 1 export added
→ qwen2.5-coder:7b streams 3 ranked candidates
→ arrow key + enter = committed

10 seconds. No cloud. No bill.

github.com/silentnova99/git-agent-local

#BuildInPublic #Ollama #Git
```

**Shorter one-liner alternative:**

```
"chore: update files" — what your cloud AI writes.

git-agent-local (local LLM + AST diff analysis):
"feat(index.js): add optional third parameter to add function"

Free, offline, `npm i -g git-agent-local`.

#Ollama #LocalAI #DevTools
```

**CTA hashtags:** `#LocalLLM #Ollama #AIcoding #DevTools #BuildInPublic #Git #OpenSource`

---

## 4. Launch-day checklist

- [ ] `npm publish` (after `npm run build` — `prepublishOnly` handles it)
- [ ] GitHub repo: topics `git`, `ollama`, `llm`, `ai`, `cli`, `local-first`, `commit-message`
- [ ] Add 3–5 screenshots/GIFs: `commit` picker, `scan` breaking-change output, `doctor`
- [ ] Create `good first issue` tickets (6 ideas in README)
- [ ] Submit to HN ~9–11am ET Tue–Thu; post launch comment instantly
- [ ] Reddit: LocalLLaMA first (most receptive), then programming, then node
- [ ] X: two-post thread with GIF; reply to Ollama/community accounts
- [ ] Cross-post: dev.to article "How I diff ASTs to make 7B models write better commits"
- [ ] Track: GitHub stars, `npm i` counts, HN points

## 5. Positioning notes

- **Lead with privacy + $0 cost** — that's the wedge vs. Copilot/CodeRabbit.
- **Lead with AST** for r/programming (technical differentiator).
- **Lead with npm one-liner** for r/node.
- **Lead with "no API key, runs on your 4090"** for r/LocalLLaMA.
- Answer HN honestly about limits (heuristic non-JS parsing) — honesty
  compounds there.
