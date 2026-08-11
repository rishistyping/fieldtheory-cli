# Field Theory CLI

Sync and store bookmarks locally, manage Field Theory Library and command workflows, and make local context available to Claude Code, Codex, or any agent with shell access.

Free and open source. Designed for Mac.

Field Theory CLI also acts as the command-line companion to the Field Theory Mac app: it knows the local `~/.fieldtheory` paths, can open Library pages in the packaged app, installs agent skills, and can download packaged app releases from the release feed.

## Repository Family

Field Theory is split across sibling repositories:

- [`afar1/fieldtheory`](https://github.com/afar1/fieldtheory): Field Theory Mac app source.
- [`afar1/fieldtheory-cli`](https://github.com/afar1/fieldtheory-cli): this CLI, licensed under MIT.
- [`afar1/fieldtheory-plugin`](https://github.com/afar1/fieldtheory-plugin): Field Theory Codex plugin and skills.
- [`afar1/field-releases`](https://github.com/afar1/field-releases): packaged Mac app release artifacts and updater metadata.

Use the app source repo for Mac app issues, this repo for CLI issues, the plugin repo for agent-plugin issues, and the release feed only for installer, download, update-feed, or release-artifact problems.

## Install

```bash
npm install -g fieldtheory
```

Requires Node.js 20+. Firefox is the default for session sync; supported Chrome-family browsers can be selected explicitly. OAuth is available for all platforms.

## Quick start

```bash
# 1. Sync your bookmarks (needs a supported browser logged into X)
ft sync

# 2. Search them
ft search "distributed systems"

# 3. Explore
ft viz
ft categories
ft stats
```

On first run, `ft sync` extracts your X session from your browser and downloads your bookmarks into `~/.fieldtheory/bookmarks/`.

## Commands

### Sync

| Command | Description |
|---------|-------------|
| `ft sync` | Download and sync bookmarks, then fetch any missing media (photos, video posters, capped videos). No API required. |
| `ft sync --no-media` | Sync bookmarks only; skip the media download pass |
| `ft sync --skip-profile-images` | Sync bookmarks and post media but skip author profile images |
| `ft sync --rebuild` | Full re-crawl of all bookmarks |
| `ft sync --continue` | Resume a paused or interrupted sync from the saved cursor |
| `ft sync --gaps` | Backfill quoted tweets, expand truncated/X Article text, enrich linked articles, and fill any media gaps |
| `ft sync --folders` | Also sync X bookmark folder tags (read-only mirror of X state) |
| `ft sync --folder <name>` | Sync a single folder by name (exact or unambiguous prefix) |
| `ft sync --classify` | Sync then classify new bookmarks with LLM |
| `ft sync --api` | Sync via OAuth API (cross-platform) |
| `ft auth` | Set up OAuth for API-based sync (optional) |

### Search and browse

| Command | Description |
|---------|-------------|
| `ft search <query>` | Full-text search with BM25 ranking |
| `ft list` | Filter by author, date, category, domain, or folder |
| `ft list --folder <name>` | Show bookmarks in an X bookmark folder |
| `ft show <id>` | Show one bookmark in detail |
| `ft sample <category>` | Random sample from a category |
| `ft stats` | Top authors, languages, date range |
| `ft viz` | Terminal dashboard with sparklines, categories, and domains |
| `ft categories` | Show category distribution |
| `ft domains` | Subject domain distribution |
| `ft folders` | Show X bookmark folder distribution (requires `ft sync --folders` first) |

### Classification

| Command | Description |
|---------|-------------|
| `ft classify` | Classify by category and domain using LLM |
| `ft classify --regex` | Classify by category using simple regex |
| `ft classify-domains` | Classify by subject domain only (LLM) |
| `ft classify --engine <name>` | Override the LLM engine for one run (also works on `ft sync --classify` and `ft classify-domains`) |
| `ft model` | View or change the default LLM engine |

#### Global Codex profile

Every Field Theory Codex invocation is pinned to `gpt-5.6-sol` with `ultra` reasoning and the fast service tier. Codex runs are ephemeral and read-only, ignore user/project instructions, and disable unrelated tools and integrations. This includes `ft wiki --engine codex`, `ft classify --engine codex`, `ft ask`, and other Field Theory features that resolve Codex. Field Theory does not inherit a different model or reasoning effort from the normal Codex configuration for these calls. Claude keeps its normal engine resolution.

#### Faster domain classification

`ft classify-domains` runs independent LLM batches concurrently and adjusts the worker count while it runs. The default plan prefers 20 workers, uses batches of 100 bookmarks, and may grow to 60 workers after sustained healthy completions. Available memory, CPU count, current CPU/RAM use, and the service cap can lower either the launch count or the live target. CPU or RAM at 80% activates the resource guard; healthy growth only occurs below 70% CPU and 75% RAM. These are safety limits, so a constrained machine may start below 20 workers.

The controller keeps successful classifications, retries only missing or failed work up to three attempts, and applies exponential backoff when the engine is throttled or unavailable. Timeouts and invalid responses reduce concurrency and split failed batches larger than 25 in half; storage errors fail immediately instead of being retried. Successful partial results are committed before omitted items are retried, so a weak response does not discard valid classifications.

Domain classification additionally uses the compact subject-classification prompt, the packaged Codex JSON output schema, and a temporary isolated Codex home.

On an interactive terminal, the native progress display shows throughput and ETA, active/target/capped workers, queued batches, CPU and RAM, peak concurrency, retry state, categorized failures, and the most recent error. Redirected output uses throttled, ANSI-free progress lines instead. Each completed run also appends a local JSONL record to `~/.fieldtheory/bookmarks/domain-classify-runs.jsonl` so performance and failures can be compared between runs. Newly created log files use mode `0600` where supported.

Advanced tuning is available through environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `FT_DOMAIN_INITIAL_CONCURRENCY` | `20` | Preferred starting worker count; resource limits may launch fewer |
| `FT_DOMAIN_MAX_CONCURRENCY` | `60` | Local hard cap for workers |
| `FT_DOMAIN_SERVICE_MAX_CONCURRENCY` | `60` | Cap used to respect an engine or account limit |
| `FT_DOMAIN_BATCH_SIZE` | `100` | Bookmarks per initial batch (`25`–`200`) |
| `FT_DOMAIN_TIMEOUT_MS` | `180000` | Timeout for one engine invocation |
| `FT_DOMAIN_WORKER_MEMORY_MB` | `128` | Estimated memory per worker for launch planning |
| `FT_DOMAIN_TUNE_INTERVAL_MS` | `1000` | Resource sampling and auto-tuning interval |
| `FT_DOMAIN_RUN_LOG` | automatic | Custom JSONL path, or `off` to disable run logging |

For example, to cap a run at 30 workers without changing its preferred start:

```bash
FT_DOMAIN_MAX_CONCURRENCY=30 ft classify-domains --engine codex
```

#### Fork enhancement reference

This implementation was developed from the `afar1/fieldtheory-cli` baseline at commit `4b4a0f6` (`fix: simplify current document editing (#178)`). The baseline ran domain classification sequentially in batches of 50. The following change map is kept here so future maintenance, debugging, and upstream comparison have durable context:

| Area | Enhancement over the baseline | Why it matters |
|------|-------------------------------|----------------|
| Scheduling | Replaced the sequential loop with an asynchronous worker pool, a preferred 20-worker start, and a configurable 60-worker ceiling | Removes the dominant wall-time bottleneck while retaining an explicit cap |
| Resource planning | Computes launch and live caps from CPU count, available memory, estimated per-worker memory, and the 80% CPU/RAM guard | Avoids treating 20 workers as mandatory when the machine cannot safely support them |
| Adaptive control | Adds slow additive growth after a healthy completion window, multiplicative decreases for congestion, and a cooldown between decreases | Prevents the controller from increasing concurrency merely because local CPU is idle while the remote service is already failing |
| Batching | Uses 100-item initial batches, configurable from 25 to 200, then splits failed timeout or invalid-response batches larger than 25 in half | Balances request overhead against response reliability |
| Retry correctness | Retries singleton batches, preserves partial successes, requeues work immediately after every settled worker, uses bounded exponential backoff, and stops after three attempts | Prevents dropped final items, unresolved scheduler exits, retry storms, and infinite work |
| Failure handling | Classifies timeout, throttle, invalid-response, engine, storage, and unexpected failures; storage failures are terminal | Gives the controller an appropriate response for each failure class instead of counting every error alike |
| Prompt efficiency | Sends compact indexed JSON records, clips very long bookmark text, marks bookmark fields as untrusted, and maps output indices back to bookmark IDs | Reduces token and serialization overhead without letting bookmark content become instructions |
| Output quality | Requests one result per input, enforces the response container/item shape with a packaged Codex JSON schema, validates compact domain slugs, rejects duplicate/out-of-range results, and retains the primary domain first | Preserves classification structure at higher concurrency and makes omitted or malformed output retryable |
| Category prefill | Reuses a single unambiguous known subject category as the domain, but does not prefill format-only or ambiguous multi-subject categories | Avoids unnecessary LLM calls without guessing when evidence is ambiguous |
| Global Codex profile | All Field Theory Codex calls use `gpt-5.6-sol`, `ultra` reasoning, the fast tier, ephemeral/read-only execution, and disabled unrelated tools; domain classification adds an isolated temporary `CODEX_HOME` containing only an auth link and removes it on completion or interruption | Keeps model quality and execution behavior consistent across `ft wiki`, classification, Q&A, and other Codex-backed commands while keeping parallel domain workers independent of local customization |
| Process lifecycle | Added async engine invocation with scoped environment, abort signals, detached process-group termination, timeout escalation, bounded output buffers, and listener cleanup | Prevents interrupted or timed-out runs from leaving Codex descendants or temporary runtimes behind |
| Terminal UX | Added a native five-line TTY display plus throttled ANSI-free redirected output | Makes rate, ETA, queue depth, worker target/cap, resource use, retries, failures, and the last error visible during long runs |
| Run history | Appends JSONL summaries with throughput, concurrency, resource peaks, failure counts, and the last error; newly created logs use mode `0600` where supported | Supports evidence-based tuning across runs without adding telemetry |
| Build packaging | Copies `domain-classification.schema.json` into `dist` during `npm run build` | Keeps installed CLI builds equivalent to source execution |
| Browser behavior | Replaced browser auto-detection as the implicit fallback with deterministic Firefox; `--browser` and `FT_BROWSER` still take precedence | Makes sync behavior reproducible across machines and fixes tests inheriting an unrelated Chromium installation |
| Regression coverage | Added tests for planning under memory pressure, controller growth/decrease rules, parsing and prefill, failure classification, TTY/non-TTY rendering, and async engine cleanup; the build verifies schema packaging | Captures the performance and lifecycle invariants that are easiest to regress |

The optimization does not change the bookmark database schema or the `ft classify-domains` command contract. Completed domains remain in the existing `domains` and `primary_domain` columns, so `ft domains`, `ft list --domain`, `ft viz`, exports, and the Mac app continue to consume the same data.

### Knowledge base

| Command | Description |
|---------|-------------|
| `ft md` | Export bookmarks as individual markdown files, including enriched article text |
| `ft md --changed` | Re-export only markdown files whose source bookmark data changed |
| `ft wiki` | Compile a Karpathy-style interlinked knowledge base |
| `ft ask <question>` | Ask questions against the knowledge base |
| `ft ask <question> --save` | Ask and save the answer as a concept page |
| `ft lint` | Health-check the wiki for broken links and missing pages |
| `ft lint --fix` | Auto-fix fixable wiki issues |

### Possibility runs

| Command | Description |
|---------|-------------|
| `ft seeds search "<query>" --create` | Save a bookmark-grounded seed |
| `ft repos add <path>` | Add a repo to the default repo set |
| `ft possible` | Interactive seed + repo + frame wizard |
| `ft possible run --defaults` | Re-run with the most-recently-used seed and saved repos |
| `ft possible run --background` | Start a run as a background job |
| `ft possible prompt <node-id>` | Print the goal prompt for one plotted node |
| `ft possible nightly install` | Install a nightly Possible run on macOS |

### Field Theory app companion

| Command | Description |
|---------|-------------|
| `ft paths --json` | Show canonical bookmarks, Library, Commands, and compatibility paths |
| `ft status --json` | Show bookmark/classification status plus Field Theory paths |
| `ft library search <query>` | Search local Field Theory Library markdown |
| `ft library show <path>` | Print a Library page and its version metadata with `--json` |
| `ft library create <path> --stdin` | Create a new Library page under `~/.fieldtheory/library` |
| `ft library update <path> --stdin --expected-sha256 <hash>` | Replace a Library page with conflict protection |
| `ft library delete <path>` | Move a Library page to Trash; the Mac app owns remote sync tombstones |
| `ft library open <path>` | Open a Library page in the Field Theory Mac app |
| `ft commands list` | List portable commands under `~/.fieldtheory/commands` |
| `ft commands new <name>` | Create a reusable portable command |
| `ft commands validate [name]` | Check command shape and guardrails |
| `ft install app` | Download and install the latest Field Theory Mac app from `afar1/field-releases` |

`ft library open` targets the packaged Field Theory app by bundle id (`com.fieldtheory.app`) instead of trusting the system-wide `fieldtheory://` handler. That avoids accidentally opening a generic Electron development app when another checkout registered the same URL scheme.

For local Field Theory app development, point the CLI at the dev checkout:

```bash
export FT_APP_DEV_DIR=/Users/you/dev/fieldtheory/mac-app
ft library open notes/example.md
```

Packaged variants can override the bundle id with `FT_APP_BUNDLE_ID`. Advanced development launchers can set `FT_APP_OPEN_COMMAND` to an executable that receives the deep-link URL as its first argument.

### Agent integration

| Command | Description |
|---------|-------------|
| `ft skill install` | Install `/fieldtheory` skill for Claude Code and Codex |
| `ft skill show` | Print skill content to stdout |
| `ft skill uninstall` | Remove installed skill files |

### Utilities

| Command | Description |
|---------|-------------|
| `ft index` | Rebuild search index from JSONL cache (preserves classifications) |
| `ft fetch-media` | Backfill/download X media assets for existing bookmarks (default: all pending bookmarks) |
| `ft fetch-media --skip-profile-images` | Download post media without author profile images |
| `ft status` | Show sync/classification status and data location |
| `ft path` | Print data directory path |

## Agent integration

Install the `/fieldtheory` skill so your agent automatically searches your bookmarks when relevant:

```bash
ft skill install     # Auto-detects Claude Code and Codex
```

Then ask your agent:

> "What have I bookmarked about cancer research in the last three years and how has it progressed?"

> "I bookmarked a number of new open source AI memory tools. Pick the best one and figure out how to incorporate it in this repo."

> "Your goal is to look at AI agent bookmarks and come up with a roadmap plotted in the grid of what I should do next across the Field Theory CLI and Mac app projects."

> "Every day please sync any new X bookmarks using the Field Theory CLI."

Works with Claude Code, Codex, or any agent with shell access.

## Scheduling

Sync with cron:

```bash
# Sync every morning at 7am
0 7 * * * ft sync

# Sync and classify every morning
0 7 * * * ft sync --classify
```

Run Possible every night on macOS with LaunchAgent:

```bash
ft seeds search "agents" --days 90 --limit 8 --frame leverage-specificity --create
ft repos add ~/dev/fieldtheory
ft repos add ~/dev/fieldtheory-cli

ft possible nightly install --time 02:00 --defaults --model opus --effort medium --nodes 5
ft possible nightly show
```

Nightly schedules are stored under `~/.fieldtheory/ideas/nightly/`. Each tick starts a normal background job under `~/.fieldtheory/ideas/jobs/`, using your local logged-in CLI sessions and the current `PATH` captured in the LaunchAgent plist.

`ft` respects standard proxy environment variables for network requests: `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, and `NO_PROXY`.

## Data

Data is stored locally under `~/.fieldtheory/`:

```
~/.fieldtheory/bookmarks/
  bookmarks.jsonl         # raw bookmark cache (one per line)
  bookmarks.db            # SQLite FTS5 search index
  bookmarks-meta.json     # sync metadata
  oauth-token.json        # OAuth token (if using API mode, chmod 600)

~/.fieldtheory/library/
  index.md                # markdown knowledge base (ft wiki / ft md)

~/.fieldtheory/commands/
  *.md                    # portable commands used by Field Theory and agents

~/.fieldtheory/ideas/
  seeds/runs/nodes/       # Possible seeds, runs, and node prompt artifacts
  batches/jobs/nightly/   # Multi-repo batches, background jobs, and schedules
```

Override locations with `FT_DATA_DIR`, `FT_LIBRARY_DIR`, and `FT_COMMANDS_DIR`:

```bash
export FT_DATA_DIR=/path/to/custom/dir
export FT_LIBRARY_DIR=/path/to/custom/library
export FT_COMMANDS_DIR=/path/to/custom/commands
```

To remove bookmark and Library data: `rm -rf ~/.fieldtheory/bookmarks ~/.fieldtheory/library`

## Field Theory Repos

The CLI is one piece of the Field Theory repo family.

- [`afar1/fieldtheory`](https://github.com/afar1/fieldtheory): Field Theory Mac app source, licensed under AGPL-3.0-or-later.
- [`afar1/fieldtheory-cli`](https://github.com/afar1/fieldtheory-cli): this CLI, licensed under MIT.
- [`afar1/fieldtheory-plugin`](https://github.com/afar1/fieldtheory-plugin): Field Theory Codex plugin and skills, licensed under MIT.
- [`afar1/field-releases`](https://github.com/afar1/field-releases): packaged Mac app release artifacts and updater metadata only.

File app-source issues in the app source repo. Keep binary installer, updater, and release-feed issues out of this CLI repo unless the bug is caused by `ft install app` or CLI launch behavior.

## Categories

| Category | What it catches |
|----------|----------------|
| **tool** | GitHub repos, CLI tools, npm packages, open-source projects |
| **security** | CVEs, vulnerabilities, exploits, supply chain |
| **technique** | Tutorials, demos, code patterns, "how I built X" |
| **launch** | Product launches, announcements, "just shipped" |
| **research** | ArXiv papers, studies, academic findings |
| **opinion** | Takes, analysis, commentary, threads |
| **commerce** | Products, shopping, physical goods |

Use `ft classify` for LLM-powered classification that catches what regex misses.

## Windows Notes

In PowerShell, use `fieldtheory` or `ft.cmd` instead of `ft` because `ft` is already a built-in alias for `Format-Table`.

If browser session sync cannot find the right profile, pass the browser and profile explicitly:

```powershell
fieldtheory sync --browser chrome --chrome-profile-directory "Default"
fieldtheory sync --browser edge --chrome-profile-directory "Default"
```

For Firefox, if profile detection misses the profile, pass the profile directory explicitly with `--firefox-profile-dir`.

If cookie extraction still fails, close the browser completely and retry. As a last resort, pass cookies manually:

```powershell
fieldtheory sync --cookies <ct0> <auth_token>
```

Treat `ct0` and `auth_token` like passwords. Do not paste them into logs, issues, or chat.

## Platform support

| Feature | macOS | Linux | Windows |
|---------|-------|-------|---------|
| Session sync (`ft sync`) | Chrome, Chromium, Brave, Edge, Helium, Comet, Dia, Firefox | Chrome, Chromium, Brave, Edge, Firefox | Chrome, Chromium, Brave, Edge, Firefox |
| OAuth API sync (`ft sync --api`) | Yes | Yes | Yes |
| Search, list, classify, viz, wiki | Yes | Yes | Yes |

Session sync extracts cookies from your browser's local database. Firefox is the default; use `ft sync --browser <name>` to pick another browser. On Windows, Firefox requires Node.js 22.5+ or `sqlite3` on PATH. For unsupported browsers or platforms, use `ft auth` + `ft sync --api`.

## Security

**Your data stays local.** No telemetry, no analytics, nothing phoned home. The CLI only makes network requests to X's API during sync.

**Chrome session sync** reads cookies from Chrome's local database, uses them for the sync request, and discards them. Cookies are never stored separately.

**OAuth tokens** are stored with `chmod 600` (owner-only). Treat `~/.fieldtheory/bookmarks/oauth-token.json` like a password.

**The default sync uses X's internal GraphQL API**, the same API that x.com uses in your browser. For the official v2 API, use `ft auth` + `ft sync --api`.

Do not open a public issue for suspected vulnerabilities, exposed credentials, auth bypasses, token-handling bugs, or private data exposure. Use the private maintainer contact in `SECURITY.md`.

## Contributing

By submitting a PR, patch, or contribution, you certify that you have the right to contribute it and agree to license it under the MIT License.

No CLA is required. Maintainers may ask for explicit signoff on larger, sensitive, or ambiguous contributions.

## License

MIT — [fieldtheory.dev/cli](https://fieldtheory.dev/cli)

## Star History

<a href="https://www.star-history.com/?repos=afar1%2Ffieldtheory-cli&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=afar1/fieldtheory-cli&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=afar1/fieldtheory-cli&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=afar1/fieldtheory-cli&type=date&legend=top-left" />
 </picture>
</a>
