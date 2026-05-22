# Clean Room

Clean Room is an agent workflow for turning authorized source analysis into clean behavioral specs, clean implementation plans, and clean destination code.

It is a POC based on ideas from [malus.sh](https://malus.sh/blog.html). It is an engineering risk-reduction workflow, not legal advice, and it does not create a legal safe harbor.

## What This Is / Does

Use this package when you need documented separation between source-reading work and clean implementation work.

It installs:

- Clean-room skills for Codex, Claude Code, and other agent runtime layouts.
- Role-agent prompts for contaminated analysis, clean planning, and clean implementation.
- JSON schemas and examples for durable workflow artifacts.
- Hook guardrails that help keep source material out of clean artifacts.
- A small CLI for runtime installation, bootstrap folders, preflight contracts, hook smoke tests, and the bounded inner clean-room runner.

The workflow creates clean behavioral spec packages and clean implementation outputs. It does not generate replacement code directly from source.

Core boundary:

- Contaminated roles may read authorized source and write contaminated artifacts.
- Source-denied roles may read only clean artifacts, implementation roots, schemas, and approved public/reference roots.
- Clean implementation code is written only under the clean implementation root.
- Raw source, source paths, private identifiers, raw diffs, copied comments, and source-shaped pseudocode must not cross into clean handoff artifacts.

For the full boundary model, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). For CLI and troubleshooting details, see [docs/REFERENCE.md](docs/REFERENCE.md).

## How To Install

Requires Node.js `>=22`.

Preferred interactive install:

```bash
npx clean-room-skill@latest
```

Non-interactive installs:

```bash
npx clean-room-skill@latest --codex --global --yes
npx clean-room-skill@latest --claude --global --yes
npx clean-room-skill@latest --all --global --yes
```

Hook modes:

- `--hooks=safe`: default. Hooks are installed but enforce only during clean-room role sessions with the required environment.
- `--hooks=strict`: fail-closed hook mode for dedicated Codex or Claude clean-room homes.
- `--hooks=copy-only` or `--no-hooks`: copy hook files without registering runtime hook config.

Verified runtimes are Codex and Claude Code. Other runtime layouts are installed on a best-effort basis. See [docs/REFERENCE.md](docs/REFERENCE.md#runtime-support) for the full support table and install roots.

Marketplace install is also supported.

Codex:

```bash
codex plugin marketplace add https://github.com/whit3rabbit/clean-room-skill.git
```

Claude Code:

```text
/plugin marketplace add https://github.com/whit3rabbit/clean-room-skill.git
/plugin install clean-room@clean-room-skill
```

## How To Run

Optionally create neutral external run folders and a clean-safe repository stub:

```bash
npx clean-room-skill@latest init
```

The default artifact base is `~/Documents/CleanRoom/<task-id>/`. Keep active contaminated artifacts, clean artifacts, and clean implementation roots separate.

In Claude Code, invoke skills with the plugin namespace:

```text
/clean-room
/clean-room:preflight
/clean-room:init
/clean-room:attended
/clean-room:unattended
/clean-room:resume
/clean-room:start-over
/clean-room:refocus
```

In Codex, invoke the `clean-room` plugin or bundled skills through `@` or the skills UI. Do not rely on Claude-style slash namespacing in Codex.

For unattended inner-loop execution from durable artifacts:

```bash
npx clean-room-skill@latest run \
  --task-manifest ~/Documents/CleanRoom/task-1234abcd/contaminated/task-manifest.json \
  --agent-commands ./agent-commands.json \
  --max-iterations 3
```

The `run` command executes one bounded inner clean-room loop for an already approved spec slice. It does not replace the outer spec-development workflow.

## Typical Workflow

![Clean Room Architecture](assets/clean-room-arch.svg)

1. Record the goal contract.
   Use `/clean-room:preflight` or `clean-room-skill preflight` before source discovery. This creates or validates `preflight-goal.json` on the contaminated/controller side.

2. Initialize preferences.
   Use `/clean-room:init` to record artifact roots, target profile, model preferences, clean-safe rules, and contaminated-only rules. The active `init-config.json` stays out of the clean implementation repository.

3. Start the controller.
   Use `/clean-room` or `/clean-room:attended` for human review gates. Use `/clean-room:unattended` only after preflight allows bounded unattended work with finite iteration limits and no open questions.

4. Analyze and sanitize.
   Source-reading roles produce neutral draft behavior specs. A source-denied sanitizer reviews handoff candidates before anything enters the clean domain.

5. Plan and implement.
   Clean roles read only approved clean artifacts and the clean destination foundation. Agent 2 writes `implementation-plan.json`; Agent 3 writes code/tests under the implementation root and reports under clean artifacts.

6. Verify and return.
   Agent 0 performs contaminated-side coverage verification after Agent 3 reaches a terminal state, then writes `clean-room-result.json`.

Use recovery skills instead of chat history:

- `resume`: continue from durable artifacts.
- `start-over`: archive or quarantine current artifacts without deletion, then restart with a fresh neutral task id.
- `refocus`: audit current artifacts against declared scope without expanding scope.

## Commands / Skills

| Command or skill | Use it for |
| --- | --- |
| `clean-room-skill init` | Create neutral external run folders and a clean-safe `.clean-room/README.md` stub. |
| `clean-room-skill preflight` | Create or validate the Stage 0 goal contract. |
| `clean-room-skill run` | Execute the bounded inner clean-room runner for one approved spec slice. |
| `clean-room-skill doctor` | Smoke test generated Codex or Claude hook registration. |
| `clean-room-skill status` | Report installed runtime version, drift, and hook state. |
| `clean-room-skill update` | Refresh installed runtime files without onboarding. |
| `clean-room` | Start the setup wizard for authorized clean-room work. |
| `preflight` | Record the required goal, policy, output, and controller-mode contract. |
| `init` | Record run preferences, separated roots, schema profile, and model policy. |
| `attended` | Start the wizard in attended mode with human review gates. |
| `unattended` | Start the wizard in bounded unattended mode with finite loop limits. |
| `resume` | Continue an existing run from durable artifacts. |
| `start-over` | Non-destructively archive or quarantine current artifacts and restart. |
| `refocus` | Audit a run and route it back to missed gates without adding scope. |

Reference files:

- [docs/REFERENCE.md](docs/REFERENCE.md): CLI flags, hook modes, troubleshooting, and local verification.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): operating model, roles, environment, guardrails, and flow details.
- [skills/clean-room/references/PROCESS.md](skills/clean-room/references/PROCESS.md): detailed clean-room process.
- [skills/clean-room/references/LEAKAGE-RULES.md](skills/clean-room/references/LEAKAGE-RULES.md): clean handoff rules.

## Development

Install dependencies:

```bash
npm ci --ignore-scripts
```

Run tests:

```bash
npm test
```

Run installer tests only:

```bash
npm run test:install
```

Run the full local verifier:

```bash
npm run verify
```

Documentation-only changes usually need review plus link/path checks, not the full test suite.

Useful development checks:

```bash
node --check bin/install.js
node --test tests/run.test.js
npm pack --dry-run
```

Python schema validation requires `jsonschema` with format extras:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install "jsonschema[format]>=4.18,<5"
.venv/bin/python tests/validate_jsonschema.py
```

Use `st` for repository search.
