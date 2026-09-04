# Changelog

All notable changes to PUM are documented in this file.

## [0.2.31-beta.1] - 2026-09-04

### Added
- Added `/model <name or provider/id> [effort]` and `/effort [level]` for main-agent model and reasoning settings, with exact matching, argument completion, and effort validation. `/model` opens the existing picker.
- Added `/store` and `/s` to save current PUM settings as global defaults.
- Added canonical session ownership locks for TUI, headless, and managed-child sessions. Worktree aliases share the same lock. Locked history selections leave the current session unchanged, and dead local owners can be recovered safely.
- Added `/resume` as an alias for the session history browser.

### Changed
- Large or multiline pasted text now stays in memory. Sending expands its editor marker into the original text for the transcript, model context, and history instead of asking the agent to read a temporary file.
- Normal output now shows the Bash output tail in at most five wrapped terminal rows and updates the tail after resize. Opening the row shows the existing expanded details.
- Tool state markers and running spinners now lead the tool text in the existing gutter. Status-bar activity uses a static icon.

### Fixed
- Printable typing now restores prompt focus after transcript selection or native blur and inserts the character once at the existing cursor. Popup fields keep typing ownership.
- Ambiguous Ctrl+H terminal bytes now retain Backspace behavior. Use `/history` or `/resume` when the terminal cannot distinguish Ctrl+H.

## [0.2.30-beta.1] - 2026-09-04

### Added
- Added GPT-6 Astra to the OpenAI and Codex model lists, including headless sessions. The fallback preserves provider authentication and transport and defers to upstream model metadata when available. Account access is still required.
- Added `r` in the model and Check model pickers to refresh available provider catalogs, with visible progress and refresh errors.

### Changed
- Updated pi packages to 0.85.0 and included the server dependency required by the published SDK.

### Fixed
- Restored beta-only npm trusted publishing. The previous workflow published the package but failed authenticating the subsequent `latest` promotion, preventing GitHub Release creation.

## [0.2.29-beta.1] - 2026-09-01

### Fixed
- Bash transcript rows now show every line of a multiline command. Live main-agent calls, managed child calls, user shell commands, and resumed sessions use the same complete command display.

## [0.2.28-beta.1] - 2026-09-01

### Added
- Added agent-managed project memory. The main agent stores bounded private Markdown facts outside the repository, shares them across linked Git worktrees, and injects them before model calls without adding them to the session transcript. Managed workers can read this memory but cannot change it.
- Added Orca activity status output through OSC 9999. PUM reports user-input, working, and completed states only when it detects an Orca terminal.

### Changed
- Managed subagents now share the project directory by default. `spawn_subagent` accepts `worktree: true` when isolation or conflict avoidance requires a separate branch.
- The `constellation` working animation now gives each star an independent period, peak brightness, and position for each appearance.
- Prerelease publication now assigns the exact package version to both npm `beta` and `latest` with the package-scoped release token.

### Fixed
- A completed subagent now leaves a transcript row when **Agent messages** is off. Ordinary inter-agent conversation remains hidden.
- Prompt-cache atomic replacement now retries transient Windows file access errors for a bounded period, including during rollback.

## [0.2.27-beta.2] - 2026-08-23

### Fixed
- Prompt blinking now stays terminal-native instead of repeatedly hiding and restoring the hardware cursor on PUM's animation clock. This prevents smooth cursor trails from jumping between the input and animated screen regions, and lets an idle screen stop rendering continuously.

## [0.2.27-beta.1] - 2026-08-21

### Changed
- Quiet transcript detail now groups failed and rejected tool calls with adjacent successful calls. Running calls remain visible until they settle, and expanding the activity row still shows each retained result.
- The prompt placeholder wave and input-rule sweep now move at half their previous speed. Prompt drag auto-scroll also uses half the OpenTUI default rate, and the prompt cursor uses a controlled 1.8-second blink cycle.

## [0.2.26-beta.3] - 2026-08-21

### Added
- Added `/providers`. It opens a list of every provider with its state, and takes `add`, `edit`, and `delete` with a provider name. Deletion removes the credential from `auth.json` for every provider, and for a custom provider it also removes the definition from `models.json`. When the deleted provider owned the active model, the session moves to another model. `/login` keeps working unchanged.
- Added `/settings`, a text front end for the same state the `Ctrl+P` panel owns. `/settings` lists every `pum.json` key with its value and its scope, `/settings <name>` shows one key with the values it accepts, and `/settings <name> <value>` changes it for this session. `--global` also writes that one key to `pum.json` and leaves the rest of the file alone. A name matches the `pum.json` key or the panel label, and case, spaces, hyphens, and underscores do not distinguish two settings. Advanced keys the panel does not show are reachable with their dotted names, such as `/settings bashOutput.maxBytes 8192`. `Tab` completes the setting name and then the accepted value.
- The prompt placeholder now says what the agent does while it works: `Working... (send to steer)` while a tool runs, and `Forming a thought... (send to steer)` while the model composes an answer. A bright crest crosses the phrase once every few seconds and raises the letter at the top of the crest. `Animations off` returns the placeholder to plain dim text.

### Changed
- The prompt now scrolls its command and path suggestions instead of dropping them. The list capped at five entries, so any match past the fifth could not be reached. Every match now stays selectable, and a five-row window follows the selection.

### Fixed
- `/settings` no longer completes a value that is already whole. A finished token kept its own row on screen, so `Enter` re-inserted the text that was already there instead of running the command. The list now stops once the token under the cursor is a whole setting name, a whole value, or the `--global` flag. A name that another name extends stops too, so `Enter` cannot turn `checkMode` into `checkModel`.

## [0.2.25-beta.1] - 2026-08-20

### Changed
- Windows now keeps its configuration in `~/.config/pum`, the same place as every other platform.

### Fixed
- An answer is no longer cut in two when the reasoning stream interleaves with it. A reasoning provider does not always finish the reasoning before the answer starts, and the late part of it used to commit the buffered answer as a finished row, which read as a line break in the middle of a sentence. The answer now keeps streaming and the late reasoning rejoins the row it came from. The same rule now covers subagent transcripts.
- Reasoning rows no longer break a word. OpenTUI's word wrap also breaks after `.`, `,`, `:`, `-`, `/` and `(`, which put `auth.` and `json` on two rows in text dense with file names and paths. Reasoning is pre-wrapped at spaces, so the renderer finds nothing to break.

## [0.2.24-beta.1] - 2026-08-20

### Fixed
- A jump to a transcript row now waits longer for the row to be drawn. A busy machine with a long session can take most of a second to draw a row that had to be mounted first, and giving up before then looked exactly like a dead key.

## [0.2.23-beta.1] - 2026-08-20

### Added
- Added `/background <prompt>`. It starts one managed agent immediately and leaves the current transcript usable. The selected transcript owns the new child, so the command creates a descendant from a subagent and a top-level agent from main. The child receives only the supplied prompt as fresh task context.

### Changed
- The transcript now mounts only the rows near its end, and older rows join the tree as you scroll back to them. OpenTUI paints just the viewport but lays out every mounted row, so a resumed session made every keystroke cost more than the last one. A 1600-row session cost 70 ms a keystroke and held 23,000 renderables; it now costs about 9 ms and holds about 1,200, whatever the length of the session. A 4000-row session could not build its render tree at all before.
- Keystrokes no longer re-render the transcript. The animation clock keeps one context value, each row is memoized on identity-stable props, and the row list is one memoized element. A changed provider value makes React walk every fiber below it, which is why a fresh object cost time proportional to the length of the session.

### Fixed
- Dragging the scrollbar to the top of a long session now reaches the first message. Every gesture used to mount one window of history and then restore the reading position, so the view did not move and an 800-row session needed fourteen drags.
- The News jump now finds its row. It used the index of the line in the transcript, but the rows on screen are the projected lines, where successful tool calls fold into one activity row, so in a session with tool calls the jump went nowhere.
- The News jump now reports an answer it cannot reach. A compaction removes the entries it summarizes, so a stored answer from before one has no row; the key returned without closing the popup and looked broken.
- Scrolling to a row can no longer be undone by the next frame. Asking for a row only schedules a render, and while the view was still at the end the next frame took the row away again, so a fast transcript-cursor walk could leave the cursor off screen.
- Goal suggestion navigation now handles a multiline prompt.

## [0.2.22-beta.1] - 2026-08-18

### Removed
- Removed the custom `apply_patch` model tool. Sessions now use pi's `edit` tool for targeted file mutations.

### Fixed
- Checking out a cached prompt now writes its text after the cache view closes, so the Windows textarea placeholder commit cannot restore an empty draft.

## [0.2.21-beta.1] - 2026-08-16

### Added
- Added a real OpenTUI Controls screenshot to the README. The screenshot capture script now generates the Transcript, Settings, and Controls images from one deterministic temporary project.

### Changed
- Improved the generated README screenshots. They use a neutral `gpt-5-codex` session, place each glyph on its exact terminal cell without SVG stretching, and crop the static scrollbar column without changing the live TUI.
- Documented the npm prerelease dist-tag requirement after `v0.2.20-beta.1` confirmed that trusted publishing covers `npm publish`, but not the later `npm dist-tag add` call.
- Prompt navigation now follows displayed wrapped rows. Home and End stay on the visible row, Ctrl navigation stays inside a non-empty prompt, and Ctrl+End retains transcript scrolling for an empty prompt.
- Text pastes longer than three lines now become `[Pasted text #n]` attachments immediately, including small stack traces. The existing 16 KiB limit still applies.

### Fixed
- A session launched with `pum w` or `pum worktree` can now use `worktree return`. CLI-created worktrees persist the same relocation record as an in-session start, and resume validates that record before restoring the worktree.
- A relocated session is now discoverable from both its source repository and generated worktree. Both locations resume the same canonical JSONL through validated pointer files, and return removes the worktree-side pointer.
- Stabilized prompt input tests that pressed Tab or Enter before the asynchronous state required by the key was ready.

## [0.2.20-beta.1] - 2026-08-16

### Added
- Added a shell command mode. `!` on an empty prompt turns the prompt into a shell command: the `!` never enters the command, the gutter shows it instead, and both input rules take the accent. Backspace or Esc on an empty command returns to the normal prompt. The command runs with PUM's own Bash operations — Check mode does not inspect a command you typed yourself, but the configured native sandbox still applies — and its result joins the session, so a running agent takes it as a steer and an idle one starts a turn with it in context.
- Added an `showAgentMessages` setting, on the Ctrl+P panel as **Agent messages**. What one agent said to another is a different question from how much tool detail to show, so it is independent of the output mode: Verbose can hide them and Quiet can keep them.
- Added `stop_subagent` for managed children, scoped to their own line of descent. Without it a child with a wedged grandchild could never finish, because `finish_subagent` refuses while a retained descendant is open.
- Added `scripts/capture-screenshots.tsx`, which drives the real TUI and converts the captured cells to SVG. The README images are regenerated from it rather than made by hand, so a rendering change is one command away from a refreshed screenshot and a screenshot can never show a layout the renderer would not produce.
- Added a `docs/` directory. The README is a hundred and twenty lines now — what PUM does, how to install it, and an index — and the rest is one file per thing you might be trying to do: command line, controls, goals, subagents, tools, safety, appearance, configuration.

### Changed
- No transcript row changes faster than it can be read. A tool call that starts and settles within 400ms is never drawn in its running form, so a quick read no longer flickers on its way into an activity group, and any row that was drawn keeps that form for two seconds. Age is measured from when the call started, so switching to an agent draws its long-running calls at once.
- Managed shells are confined by the native sandbox, exactly as the Bash tool is. The adapter that does it had been written and tested but never wired, so with Check mode on a `start_shell` could run work `bash` would have blocked.
- Opening a tool row outside Verbose is compact: the result's last twenty lines with a count of the rest, no JSON envelope, and no echo of arguments the row above already spells out. An opened group of reads is the files with their offsets. Verbose is unchanged, and copying a row still copies everything retained.
- Every tool-related row shares one indent, whatever the tool is called, and every tool row gets a blank line above it. The activity row lost its disclosure arrow; the gutter stays clickable.
- `message_agent` refuses only a bare completion report. A message that names where the work landed, asks for something, or runs long now arrives, whatever word it opens on.
- Trigger tool results are bounded at 8,000 characters. A template can be 64,000, so the model's own input could crowd out the context it needed to act on it.

### Fixed
- A row with the working caret is no longer blank until the first animation tick. It was handed empty content and repainted imperatively on the frame clock, so the body of a running tool row flashed empty, and a loaded machine could hold it there long enough to fail a test.
- The Release workflow publishes through npm trusted publishing. GitHub Actions presents the job's OIDC identity and npm issues a credential for that one publish, so no token is stored, nothing expires, and nothing works from a laptop. The dist-tag promotion keeps a token for now, because it is a second registry call the publish credential may not cover.
- Switching to an agent no longer replays command output that already ended. The live output period was component state, so remounting a row restarted it, showing output again for two seconds every time you came back. The period now belongs to the call and never reopens.
- A resumed session keeps its diffs. Replay never derived a tool preview, so an edit showed its diff while the session ran and nothing at all after it was loaded from history, and a restored subagent lost every diff it had. A tool row is now built the same way from live events and from replay, and a test compares the two.
- A call whose turn ended without a result reads as interrupted rather than running. It was already shown that way after a reload, but a cancelled turn left a row spinning for the rest of the session.
- Turning thinking traces on reveals the reasoning of a resumed session. The main transcript dropped it at capture and at load when the setting was off, while a subagent always kept it and filtered at render, so the setting worked in one view and not the other.
- Two PUM processes on one session cannot lose each other's tool-group state. Every other companion file wrote through a temp name carrying the pid and the clock; `saveToolGroups` used a plain `.tmp`, which is the race the others guard against. Companion files now share one implementation, which also removes a half-written temp file instead of leaving it beside the session.

`0.2.19-beta.1` was tagged but never published: the publish failed on
authentication before the registry accepted the tarball, and the fix changed the
workflow, so the candidate was replaced rather than retagged.

## [0.2.18-beta.1] - 2026-08-16

### Added
- Added transcript output levels, on the Ctrl+P panel as **Transcript detail** and in `pum.json` as `outputMode`. Quiet folds every successful tool call into one activity row, commands and mutations included. Normal keeps those as their own rows and shows an editing tool's diff inline, syntax highlighted and capped at twenty changed lines. Verbose shows the complete retained input and result of every row.
- Added expanding a single transcript row, by keyboard or by clicking its gutter. An expanded row shows everything the tool retained, whatever the output level. Five tree-sitter grammars are vendored under `assets/` — Python, JSON, Bash, Rust and Go — so a diff highlights offline and on the first run.
- Added working-rule animations. The `workingRuleAnimation` setting takes `off`, `input-only`, `coordinated`, `comet-pair`, `electric-spark`, `constellation`, `random-constellation` and `energy-transfer`.
- Added an inline goal review row. One review is one row: it appears the moment the turn settles, before the repository state is collected, and is rewritten in place with its outcome — completed, continuing, blocked, failed, discarded, cancelled or error. Only a row still reviewing is rewritten, so the first outcome wins and a cancel cannot overwrite a verdict you have already read.

### Changed
- Signal colours mean one thing each. Red is errors and removed lines, green success and added lines, orange blocked, and nothing else. A tool row reads `tool(first, second)` with the name, brackets and commas dim and the arguments in the accent, so the only signal on a settled row is the marker at its right edge. The disclosure arrow is gone from tool rows; the gutter stays clickable.
- Revealing a row anchors its first line to the top of the viewport rather than dragging it just into view at the bottom.
- Every working animation runs through one glow core: shaped strength, blended in linear light, bloomed towards white past the knee, with raised-cosine falloffs and a per-column wake decayed on elapsed milliseconds. Equal-colour columns merge into one chunk, so a wide rule costs tens of chunks a frame rather than one a column. The sparkle trail is gone from the mode list, and each sparkle of the random constellation starts at its own hashed point in the cycle instead of lighting and dying on one beat.
- Cancelling a turn stops an active goal. An abort still settles the turn, so the goal used to review the work you had just stopped and continue it. Esc now stops the goal first and says so; `/goal continue` resumes it.
- `/goal stop` keeps the blocked question, so `/goal status` can still show what the judge asked. `/goal continue` clears it.
- Path suggestions wait for a three-character fragment instead of opening on the first slash.
- The prompt cache is shared across a repository's Git worktrees, so history and the stash follow you between them.
- Open-resource reminders queue on the sixth settled turn rather than the third.
- The managed worktree tools explain themselves better to the model.

### Fixed
- Heading markers no longer flicker through streamed Markdown. Coalesced blocks handed the renderer one synthetic token whose synchronous placeholder came from the inline lexer, which does not know block syntax, so every streamed chunk repainted the `##` until the asynchronous highlight concealed it.
- A goal judge that settles is discarded, so a review that ends without a verdict cannot leave the goal waiting on it for good.
- A goal review waits for an external trigger that is running or holding an undelivered result, and starts when the trigger releases.
- The goal judge and the AFK delegate are spawned with the provider-qualified model id, so they run on the session's model rather than failing to resolve it.
- A stored goal longer than the 4,000-character limit loads as no goal, the limit `/goal` itself enforces.
- The `/goalf` proposal parser builds its pattern from the marker the prompt asks for, so the two cannot drift apart.

## [0.2.17-beta.1] - 2026-08-16

### Added
- Added `worktree` tool actions `start` and `return`, so the main agent can move its own session. The move is scheduled and happens once the calling turn ends, never in the middle of it. Managed children cannot use them.
- Added `/worktree start [directory]` and `/worktree return`, which move the running session into a generated worktree and back. The session keeps its id, transcript, goal, todo list and settings; nothing is copied or forked. Returning leaves the worktree, its branch and any uncommitted work untouched, so it can still be inspected, merged or removed later. The source repository stays writable while the session runs in the worktree.
- Added per-agent todo lists. A hidden `Todo` tool group gives the main agent and each managed child `todo_list`, `todo_add`, `todo_update`, `todo_complete` and `todo_delete`, each bound to its own session so no agent can read or change another's plan. Readonly children keep the tools. `Ctrl+O` and `/todo` open a view-only popup for the selected transcript, with `f` to filter.
- Added `/afk`, which answers model questionnaires while you are away. Each questionnaire goes to one fresh delegate holding a single tool - no files, no shell, no network, no delegation. `/afk` alone toggles it, `/afk <instructions>` starts or re-steers it, and any failure hands the questionnaire straight back to you. AFK is process-local: it is never written to disk and never survives a restart.
- Added `pum worktree [directory]` and `pum w [directory]`, which create an auto-named worktree under `<repo>/.pum/worktrees` and start a fresh session in it. The source repository stays writable for that process only, without touching your saved `/check-path` settings. Uncommitted source changes are not copied, because creation uses the current commit.
- Added session-scoped settings. Changes in the Ctrl+P panel now apply to the current session and persist beside it, leaving the global `pum.json` alone; `s` in the panel saves them as the global defaults.
- Added absolute and home path completion. `/` and `~/` now complete, alongside project-relative paths, with credential paths and symbolic links still excluded.
- Added an autonomous goal mode. `/goal <text>` stores a goal with the session and starts work at once; `/goalf <draft>` interviews you first and stores nothing until you confirm the one goal it proposes. `/goal stop`, `/goal continue`, `/goal status`, and `/goal clear` control it, and replacing or clearing a goal asks first.
- Added judge-driven continuation. After a settled main turn, once no managed worker is running and no queued message is waiting, a fresh readonly judge reviews the repository and returns one verdict: complete the goal, ask you a single question, or write the next instruction and start another turn. It holds no worktree, counts as no worker, and is removed after each review.
- Added a `goalRetryLimit` setting, on the Ctrl+P panel and in `pum.json`. It bounds consecutive incomplete reviews, defaults to 10, accepts 0 through 100, and 0 means no limit.
- Added a goal label to the full-width rule above the prompt. It shows the state and the goal, keeps the rule one row, truncates on grapheme boundaries, and animates with the rule.

### Changed
- No agent can write the PUM config directory any more. The main agent's exact-file allowance for `settings.json`, `pum.json` and `theme.json` is revoked, since settings are session-scoped and only the Settings panel promotes them.
- An absolute path no longer matches a slash command, so Tab on `/u` completes `/usr/lib` instead of turning it into `/new`.

### Fixed
- Staged pasted text and captured bash output are reachable on Windows accounts with an 8.3 short name. PUM stored the path `mkdtemp` returned rather than the canonical one the sandbox registered, so it handed the agent a path its own sandbox then refused.
- The prompt cache no longer loses an entry when two PUM processes write at once. The cross-process lock gave up after two seconds of contention and carried on unlocked, and read a contended exclusive create on Windows as "this filesystem cannot lock".
- A repository whose directory name ends in a space resolves. The trailing space was trimmed off the path git reported, leaving a path that does not exist.
- Orphaned `.goal.json` files are swept when a session is deleted. The sweep never knew about them, so one was left behind for every session removed since goals shipped.
- `/afk` is listed with the other commands, so it has a suggestion row and completes on Tab. It was routed ahead of the model already, but it was the one command missing from the list.
- An attached image keeps its offsets when a pasted-text marker is edited in the same keystroke. The image positions were recalculated before the pasted-text cut rather than after it, so the next keystroke read offsets pointing past that cut.

## [0.2.16-beta.2] - 2026-08-15

### Fixed
- Stopped a crash while the prompt input is torn down. A queued frame or microtask that measured the editor after OpenTUI destroyed it threw `EditorView is destroyed`; the measurement now returns instead of throwing.
- Shortened help rows that no longer fit the popup. `Ctrl+Backspace` and `Ctrl+W` share one row, `/processes` and `/triggers` share one row, and the `Ctrl+P` row carries the settings search key.

## [0.2.16-beta.1] - 2026-08-15

### Added
- Added an outer sandbox around the whole agent. `pum s` starts PUM in a writable container, `pum sr` keeps the current directory read-only, and `pum ss` prepares or updates the runtime. Extra directories mount with a `:ro` or `:rw` suffix, the agent directory is mounted writable, and `pum sr` refuses to start when `PUM_DIR` sits inside the read-only project.
- Added a prompt input mode. `Alt+I` toggles it; `Enter` then inserts a new line instead of sending, and the prompt caret shows `i`.
- Added local path completion in the prompt. `Tab` completes a path, and the candidates stay inside the project and the approved roots.
- Added cursor editing in the login fields. Arrow keys, `Home`, `End`, `Backspace`, and `Delete` now work at any position instead of only at the end of the text.

### Changed
- Applied the thinking-visibility setting to subagent transcripts, so hidden thinking stays hidden in a subagent view.
- Reworded the help popup rows and the Check mode and Check model setting descriptions.

### Fixed
- Kept queued child messages after a cancel. Aborting the main turn no longer drops a queued steer, and the running prompt is restored only when no queued steer survives.
- Recovered the prompt after a failed send. The draft and every still-valid attachment marker return instead of being lost with the editor.
- Kept clipboard image markers atomic. A selection or a caret inside a marker now expands to cover it before the new marker is inserted.
- Stopped a modal cancel key from typing its character into the prompt.
- Used the saved Check mode when starting inside the outer sandbox instead of forcing the default.

## [0.2.15-beta.1] - 2026-08-14

### Added
- Added the **Output** transcript setting with `minimal`, `default`, and `detailed`. Minimal aggregates tool rows into a short summary, and detailed adds a result preview under Bash, `write`, and `edit` rows. Switching the mode regenerates the transcript from the canonical replay, so earlier rows follow the new mode too.
- Added managed background shells. `start_shell`, `list_shells`, `inspect_shell`, `get_shell_output`, and `kill_shell` run and supervise long-lived commands; the Processes popup gains a Shells tab and the status bar counts running shells. Shells go through the same sandbox as Bash, readonly subagents do not get the tool group, and shutdown stops every shell.

## [0.2.14-beta.1] - 2026-08-14

### Added
- Added forked subagent conversations. A spawned subagent can start from a copy of the parent conversation up to the current entry instead of from an empty session, and the spawn preview shows the choice.

### Changed
- Condensed the Simplified Technical English writing-style prompt. Every rule stays; the per-turn context is smaller.

### Fixed
- Kept Bash output on screen after the command finishes. Live output now stays visible for at least two seconds instead of disappearing the moment the call completes.

## [0.2.13-beta.1] - 2026-08-13

### Added
- Added configurable Bash output summarization (`src/bash-output.ts`). The default
  keeps the first 30 / last 40 lines within 3KB, strips ANSI, drops progress-only
  lines, compresses repeated and similar runs, and re-injects FAIL/error/warning
  lines from the elided middle. PUM tees the exact stream to its own trusted
  private temp file, so elided output stays recoverable below pi's 50KB limit,
  and never reads a file path parsed from command output.
- The Bash tool schema gains `full_output` (return pi's native output),
  `strategy`, `max_bytes`, and `patterns` (regexes whose matching raw lines
  survive elision). Extracted lines and the marker share one final hard byte
  budget.
- Added the `bashOutput` setting in `pum.json`, with defaults, extreme-value
  clamping, and normalization.

### Changed
- Split the `/stats` tool outcome for running and interrupted calls. Running uses blue, and interrupted uses dark gray.
- Delay live Bash output until a command runs for 500 ms. Failed Bash rows show the exit code after a `·` separator.

## [0.2.12-beta.1] - 2026-08-12

### Added
- Added managed subagent completions to News. Direct and nested completion entries include the finishing agent, requester, finish summary, and final response. Stable settlement identities prevent duplicates across delivery, acknowledgement, and session resume. News navigation now targets the relevant completion transcript rows while preserving read, reply, and copy behavior.

### Fixed
- Fixed Check mode parsing for valid Bash `case` patterns. Pattern terminators such as `success|failed)` no longer produce an unmatched-parenthesis error, and pattern alternatives are no longer classified as pipelines.

## [0.2.11-beta.1] - 2026-08-12

### Fixed
- Stopped the transcript from crashing when a slash command set the busy state over an existing text or tool row. Text and tool rows now keep a defined content value while the working-caret hooks own the renderable, so OpenTUI no longer receives an undefined `content` update, which crashed in `setStyledText`.

## [0.2.10-beta.1] - 2026-08-12

### Added
- Added a non-interactive mode. `pum -p "<text>"` (or `--prompt`) runs one prompt without the TUI, streams the answer to stdout and tool progress to stderr, then exits. It uses the read, write, edit, apply_patch, and bash tools with the configured Check mode, sandbox, writing style, and explanation strength. The session persists to the normal per-directory store, so `-r` and the TUI can continue it.
- Named PUM in the system prompt. The agent now identifies as PUM instead of the underlying harness, and the harness documentation routing is removed from the prompt.
- Added readonly subagents with a fail-closed child tool guard, so an inspection subagent cannot change files, commit, delegate, or start processes.
- Added a process-local filesystem sandbox that bounds the file tools to the project and approved roots.
- Added `n` and `p` jumps in the News popup to move to the answer and to the user prompt, alongside `c` to copy.
- Added idle open-resource reminders for background subagents and trigger-only idle cycles.

### Changed
- Simplified Check mode to an on/off toggle. `on` runs the former `balanced` behavior; the `strict` and `ask` profiles, the approval popup, the exact-approval store, and the `clearCheckApprovals` action are removed. Legacy settings values `strict`, `balanced`, and `ask` migrate to `on`; `off` stays `off`. A verifier `UNSAFE` result blocks; a recognized direct `npm publish` or `npm dist-tag add` from the main agent is allowed.
- Made the subagent capacity note in the system prompt cache-stable by reporting slot availability instead of an exact count.
- Showed the web search argument on the tool line, and showed the enabled `enable_tools` groups.

### Fixed
- Prevented a managed subagent guard bypass. A `worktree` merge or remove that names a subagent by its branch now hits the same running-status, descendant, and force-removal checks as a name or id.
- Re-delivered a subagent completion notice that a queue clear could drop. Cancelling the main turn or recalling a queued message no longer loses the notice, so a managed merge is not stuck.
- Kept a completed subagent from downgrading to idle after a bare acknowledgement turn, which had blocked its merge.
- Aborted a conflicted worktree merge so the main worktree returns to a clean state, and recovered a managed agent whose worktree directory was pruned so it no longer blocks its parent.
- Fixed apply_patch defects: co-located insertion and replacement no longer corrupt a file; `Add File` on an existing path fails instead of overwriting; a `Move to` surfaces its source path and a non-empty diff; rollback falls back to a copy and names the backup; a `@@ ` header with a trailing space behaves like a bare `@@`; and line-ending normalization no longer rewrites untouched lines.
- Hardened the sandbox: a Require-mode startup block no longer suppresses a later Auto fallback warning; invalid environment variable names are dropped; the shell executable directory is mounted read-only on Linux; more `.env` variants are denied; a Windows non-zero exit is not misreported as a timeout; and a `bin` shell under a drive root no longer exposes the whole drive.
- Hardened external triggers: a denied rerun no longer aborts the settle batch; a delivery cannot settle twice; cancelled or expired definitions free their slot; and termination escalates to a process-tree kill.
- Stopped the hosted web-search tool from attaching to the Check mode verifier request, and chained the provider payload hook so a `before_provider_request` extension still runs on Codex.
- Fixed TUI state races: a switch-then-send or switch-then-cancel in one input chunk now targets the newly selected agent; a settings change is not reverted by a following change in the same chunk; deleting a cached prompt reindexes every view; a large paste while the News popup is open no longer lands in the hidden prompt; and a spawn-preview approval binds to the request the popup rendered.
- Fixed help popup pagination and removed duplicate trigger transcript lines.

## [0.2.9-beta.1] - 2026-08-11

### Added
- Showed the user prompt and follow-up steers that produced each answer above the answer in the News popup, styled like the transcript's user rows.
- Added a `c` shortcut in the News popup to copy the selected answer to the clipboard through the same routes as text selection (native, command, or OSC 52 over remote sessions).
- Added `/news` to the command completion list so it previews like the other commands.

### Changed
- Marked a news answer read only when a new user prompt follows it directly in the transcript. Subagent messages, trigger events, queued messages, and in-progress streams now stop the mark.

### Fixed
- Tagged resumed transcript answer lines with their news identifiers at launch, so read markers appear on resume exactly as on a session switch.
- Documented `Ctrl+W` as a word-delete shortcut alongside `Ctrl+Backspace` in the help popup.
- Wrote `pum.json` through a temporary file and atomic rename so a crash during a save cannot corrupt the settings file.

## [0.2.8-beta.1] - 2026-08-11

### Added
- Added a News popup (Ctrl+N or `/news`) listing the final answers of user-initiated turns, newest first. Answers persist next to the session and keep their seen state across resume.
- Made the News popup body render through the Markdown renderer with its own scrollbar, so headings, lists, and code render and long answers scroll.
- Allowed Space in the News popup to toggle an answer between read and unread.
- Grouped PUM custom tool schemas behind a per-session `enable_tools` gate: the Core tools are always sent; the Admin, Subagents, and Worktree groups are hidden until enabled and their enabled state survives resume.
- Told the model what the active Check mode profile allows and denies by injecting a per-turn guidance block that updates when the profile, sandbox, or approved roots change.
- Made pasted text larger than 16 KB use a `[Pasted text #n]` marker backed by a temporary file the model can read; the file is removed when the snippet is deleted, the draft clears, or the turn settles.

### Changed
- Enlarged the News popup to use most of the terminal instead of a fixed small box.
- Preserved hand-tuned per-model settings such as thinking level maps and compatibility flags when the provider is logged in again.

### Fixed
- Made Shift+Enter and Ctrl+Enter insert a newline on Windows Terminal with PowerShell 7 by decoding kitty and modifyOtherKeys sequences; plain Enter still sends.
- Made the multiline prompt gutter follow the cursor when it moves with arrow keys, Home/End, or the mouse, not only when typing.
- Fixed Check mode to treat `/dev/null` as a null device on every path flavor and Git Bash drive paths as native drives, so read-only inspection commands such as `grep -E`, `cat`, `head`, `tail`, `wc`, `rg`, and `ls` pass Balanced appropriately, and `cd` into the project worktree no longer false-flags.

### Security
- Allowed the authoritative main agent to deliberately edit its own settings files (`settings.json`, `pum.json`, `theme.json`). `auth.json`, model key material, and session content stay blocked; managed subagents stay blocked; an enforced native sandbox still denies the config root.

## [0.2.7-beta.1] - 2026-08-11

### Changed
- Simplified the status-bar working-directory field to show only the compact directory name before the Git branch.
- Allowed Balanced Check mode to perform release installation verification only for one exact registry package version with lifecycle scripts disabled and explicit project-local prefix and cache paths.

### Fixed
- Made the Thinking level setting navigate through only the levels supported by the active main-agent model, so custom models can move down from `max` to their next supported level.
- Made selected-subagent status assertions independent of terminal widths that legitimately show or hide lower-priority cost metadata.

### Security
- Kept global, lifecycle-enabled, aliased, composed, unsupported, non-exact, credential, ambiguous, external-write, and escaping package installation forms blocked in Balanced mode.

## [0.2.6-beta.1] - 2026-08-11

### Added
- Added the launch working-directory name immediately before the Git branch in the one-row status bar, with a dedicated semantic theme color and responsive removal on narrow terminals.

### Changed
- Allowed Balanced Check mode to run one direct, lifecycle-disabled `npm pack` with an explicit project-local cache and either the current package or one exact registry package version.
- Updated release validation and installation verification to keep npm cache and package output inside the project.

### Security
- Kept file, Git, URL, tag, range, credential, external-write, shell-composed, and global-install package operations blocked; npm publication and dist-tag mutations still require the existing authoritative main-agent approval path.

## [0.2.5-beta.1] - 2026-08-11

### Fixed
- Removed the special background from Check mode rejected tool and reason rows, while keeping all rejection text orange and rendering the exact `Check mode hard block:` prefix with a visible bold attribute.
- Added bracketed-paste and local `Ctrl+V` support for custom-provider endpoint and API-key fields without exposing secret text in React state, labels, logs, errors, or sessions.

### Security
- Bounded local clipboard text capture, used direct process arguments, and blocked host clipboard fallback in remote sessions.

## [0.2.4-beta.1] - 2026-08-10

### Fixed
- Made direct selected-subagent delivery coverage await the durable manager path instead of renderer settlement, removing a Windows-only tag-CI timing race.
- Replaced `0.2.3-beta.1` after its package and GitHub Release published successfully but Windows tag CI failed on the flaky UI assertion.

## [0.2.3-beta.1] - 2026-08-10

### Added
- Added `Ctrl+End` to scroll the selected transcript to the bottom and restore sticky scrolling.

### Changed
- Made prompt input wrap at word boundaries with character fallback for long tokens, matching transcript alignment.
- Rendered Check mode rejection text in orange without changing its background and made the `Check mode hard block:` prefix bold.
- Upgraded official GitHub Actions to Node 24-based releases.

### Fixed
- Made cached-task sends transactional so failed main or child delivery leaves entries pending, while successful delivery commits executed state without duplicate assignment races.
- Persisted subagent completion acknowledgements only after the notice enters the parent session, including crash-window retry and replay coverage.
- Stabilized Windows mutation previews by rejecting unmatched drive and UNC roots before remote filesystem identity probing.
- Forced MXC capability probing to select native Windows `whoami` even when Git or MSYS tools appear first in `PATH`.

### Security
- Required managed agents to have authoritative `completed` status and a persisted matching completion notice before merge; idle or other retained states cannot merge.
- Required open cached tasks to execute through `message_cache_send` before assignment and prevented duplicate agents when the authoritative coordination prompt arrives.

## [0.2.2-beta.1] - 2026-08-10

### Added
- Added dynamic terminal titles that report PUM activity and active subagent counts on Windows, Linux, and tmux-compatible terminals.
- Added native Bash sandbox modes with Bubblewrap enforcement on supported Linux hosts and MXC BaseContainer/CreateProcessInSandbox enforcement on supported Windows hosts.

### Changed
- Allowed Balanced Check mode to read explicit non-sensitive external paths while continuing to block external writes, execution, location changes, ambiguous access, and credential paths.
- Classified filesystem access and network intent deterministically, supplied external reads as read-only sandbox grants, denied network access by default, and applied the sandboxed Bash override to main and managed child sessions.
- Added Auto, Require, and Off sandbox settings with visible non-session fallback warnings and fail-closed Require behavior.

### Fixed
- Stopped Windows Check mode from interpreting `printf` and `echo` data as drive-root-relative paths in compound repository-local Git inspection commands.
- Prevented OAuth controller tests from opening a real browser device-code URL.

### Security
- Added private command temporary directories, credential and PUM configuration masks, sensitive environment filtering, process-tree cancellation, and direct external-read upload blocks.
- Rejected the Windows AppContainer+DACL fallback because it can modify persistent host ACLs; PUM accepts only MXC's native BaseContainer tier.

## [0.2.1-beta.1] - 2026-08-10

### Fixed
- Canonicalized Windows short-name, long-name, case, and missing-leaf path identities for additional Check mode roots, edit previews, and containment checks without weakening symlink or junction protections.
- Rejected unapproved Windows UNC edit targets before filesystem probing and made sequential transcript-selection coverage deterministic across CI runners.

### Changed
- Gated release tagging on successful Ubuntu and Windows CI for the exact release commit, with failed candidates fixed in a new commit and revalidated before any tag is created.

## [0.2.0-beta.4] - 2026-08-10

### Added
- Added `/check-path list|add <directory>|remove <directory>|clear` for up to 16 project-scoped additional Check mode roots used by bash, edit, and external-trigger checks.

### Fixed
- Rendered denied tool calls with warning colors, a `!` marker, and the denial reason on the following line, including persisted session replay.
- Stopped caret-only Markdown updates from reparsing streamed headings and briefly exposing their raw marker prefixes.

### Security
- Kept additional Check mode roots subject to canonical validation, credential boundaries, traversal and escaping-link checks, broad-deletion blocks, and the existing hard-rule policy; `apply_patch` remains project-local.

## [0.2.0-beta.3] - 2026-08-10

### Fixed
- Made prerelease dist-tag verification tolerate npm registry propagation after publication, allowing the workflow to proceed to GitHub Release creation.
- Gave the real Git worktree integration test enough time on slower Windows runners and retried transient Windows `EBUSY` cleanup failures without weakening lifecycle assertions.
- Replaced `0.2.0-beta.2` after its package and provenance published successfully but its post-publication verification exited before creating the GitHub Release.

## [0.2.0-beta.2] - 2026-08-10

### Fixed
- Authenticated npm publication and prerelease dist-tag promotion with the existing package-scoped release token while retaining provenance.
- Made status-header agent-count tests deterministic across Windows and Ubuntu without depending on an animated bullet painting in a specific frame.
- Replaced the unpublished `0.2.0-beta.1` candidate after its release workflow failed before npm publication or GitHub Release creation.

## [0.2.0-beta.1] - 2026-08-09

### Fixed
- Open provider OAuth and device-code verification URLs automatically with the platform browser, while keeping selectable URL fallback and rejecting unsafe URLs.
- Copy completed transcript selections to the local clipboard on Windows and macOS, use Linux clipboard commands when available, and use bounded OSC 52 output for remote sessions.
- Enable selection on transcript Markdown renderables despite the missing OpenTUI 0.5.1 React prop type.

### Changed
- Made the release workflow promote prereleases to both npm `beta` and `latest` using a package-scoped `NPM_TOKEN`, while keeping package publication on trusted-publishing OIDC.

## [0.1.3-beta.2] - 2026-08-09

### Fixed
- Made transcript wrapping coverage stable whether OpenTUI paints Markdown content in the test renderer or leaves it unpainted.
- Made exact POSIX `/dev/null` policy fixtures independent of the host operating system, including virtual escaping-symlink coverage on Windows.
- Replaced the unpublished `0.1.3-beta.1` candidate after CI caught both portability failures before npm publication or GitHub Release creation.

## [0.1.3-beta.1] - 2026-08-09

### Added
- Added optional `spawn_subagent` previews with a responsive Markdown approval popup and a separate user note delivered after spawn.
- Added provider-list search and metadata filtering to the login flow.
- Added `pum --help`, `pum -h`, `pum --version`, and `pum -v` with side-effect-free early CLI dispatch.
- Added Up Arrow recall for the newest undelivered user message in the selected main or child transcript.
- Added subtle semantic popup shadows and terminal-height scaling for Settings.

### Changed
- Made the status header stay on exactly one row and remove lower-priority fields progressively as terminal width decreases.
- Made Help categories stack vertically when two columns would clip on narrow terminals.
- Changed Ask mode to require the approval popup for every non-hard-blocked checked call unless an exact prior approval matches.
- Changed Balanced mode to permit complete ordinary project-local work, including long validated patches, while blocking hard rules, suspicious execution, obfuscation, malformed input, and explicit verifier `UNSAFE` decisions.
- Allowed the authoritative main agent to request exact approval for direct `npm publish` and exact-version `npm dist-tag add` calls.

### Removed
- Removed the public synthetic Fire action from external triggers. Manual Run continues to execute the configured process through Check mode.

### Security
- Allowed only the exact POSIX `/dev/null` device through project-boundary checks; other device and external paths remain blocked.
- Bound spawn previews, queued-message recall, and Ask approvals to authoritative main or child identities outside model input.

## [0.1.2-beta.1] - 2026-08-09

### Fixed
- Fixed a Windows session-history metadata test that treated a native nested path as one opaque filename.
- Fixed broad-deletion policy test fixtures by quoting generated Windows paths without weakening production hard blocks.
- Fixed an intermittent `/new` usage-reset test race by waiting for the observable asynchronous session transition.

## [0.1.1-beta.1] - 2026-08-09

### Added
- Added process-local external triggers with supervised executable/argument execution, exact session and subagent routing, Check mode verification, bounded output, lifecycle controls, and a Ctrl+T management popup.
- Added model-callable message-cache tools with stable IDs, user and agent ownership, exact deletion authorization, and normal prompt or batch execution paths.
- Added interactive model questionnaires with selectable options and custom answers for main and managed child agents.
- Added session-history metadata for latest sent messages, on-disk size, and known outgoing, incoming, and cache-read token counts.
- Added configurable active-subagent capacity from 1 through 25, with a default of 10.
- Added a project release skill that audits documentation, writes this changelog, validates, tags, publishes, and verifies patch releases.

### Changed
- Redesigned Check mode with off, strict, balanced, and ask profiles; deterministic hard blocks; structured verdicts; diff-based mutation review; and exact once, session, or project approvals.
- Made managed parent closure recursive and deepest-first. Every retained descendant now blocks finish, merge, and removal.
- Made subagent idle and completion notifications durable and exact per work cycle, including direct-spawner routing and restart-safe delivery deduplication.
- Limited prompt history to the 100 latest sent occurrences plus every stashed occurrence, while preserving duplicates and normalized workspace identities.
- Made Ctrl+C clear the selected non-empty draft while preserving double-Ctrl+C quit on an empty draft.
- Improved streamed Markdown stability, tool-row wrapping, read argument display, rejected tool styling, and Settings Escape behavior.

### Fixed
- Fixed Windows CI portability for Git CRLF checkouts, project-relative path display, structured deletion checks, and exhaustive Markdown streaming tests.
- Fixed session-switch cancellation and focus restoration, child-transcript selection after switching, pending-image protection, and current-session history selection.
- Fixed nested completion routing, duplicate completion reports, pending message ordering, trigger target invalidation, and multiple subagent lifecycle race windows.
- Fixed system-prompt contradictions around approval behavior, idle versus completion, Ctrl+C, and successful `finish_subagent` calls.

### Security
- Added deterministic blocks for project escape, credential access, privilege escalation, persistence, remote-script execution, destructive Git operations, and broad deletion.
- Added sanitized trigger environments, inert templates, strict argument-boundary checks, private bounded output files, and non-overridable hard-block or explicit `UNSAFE` decisions.

[0.2.29-beta.1]: https://github.com/eugen1763/Pum/compare/v0.2.28-beta.1...v0.2.29-beta.1
[0.2.28-beta.1]: https://github.com/eugen1763/Pum/compare/v0.2.27-beta.2...v0.2.28-beta.1
[0.2.2-beta.1]: https://github.com/eugen1763/Pum/compare/v0.2.1-beta.1...v0.2.2-beta.1
[0.2.1-beta.1]: https://github.com/eugen1763/Pum/compare/v0.2.0-beta.4...v0.2.1-beta.1
[0.2.0-beta.4]: https://github.com/eugen1763/Pum/compare/v0.2.0-beta.3...v0.2.0-beta.4
[0.2.0-beta.3]: https://github.com/eugen1763/Pum/compare/v0.2.0-beta.2...v0.2.0-beta.3
[0.2.0-beta.2]: https://github.com/eugen1763/Pum/compare/v0.2.0-beta.1...v0.2.0-beta.2
[0.2.0-beta.1]: https://github.com/eugen1763/Pum/compare/v0.1.3-beta.2...v0.2.0-beta.1
[0.1.3-beta.2]: https://github.com/eugen1763/Pum/compare/v0.1.3-beta.1...v0.1.3-beta.2
[0.1.3-beta.1]: https://github.com/eugen1763/Pum/compare/v0.1.2-beta.1...v0.1.3-beta.1
[0.1.2-beta.1]: https://github.com/eugen1763/Pum/compare/v0.1.1-beta.1...v0.1.2-beta.1
[0.1.1-beta.1]: https://github.com/eugen1763/Pum/compare/v0.1.0-beta.3...v0.1.1-beta.1
