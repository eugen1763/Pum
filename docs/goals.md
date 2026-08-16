# Goals

[← Back to the README](../README.md)

A goal is one durable instruction that outlives a single turn. `/goal <text>`
stores it beside the session and starts work at once. `/goalf <draft>` runs one
interview turn first — it asks only the questions that would change the goal and
stores nothing until you confirm the one it proposes.

| Command | Action |
|---|---|
| `/goal <text>` | Set a goal and start it |
| `/goalf <draft>` | Work a goal out with the model, then confirm it |
| `/goal status` | The complete state, with untruncated text |
| `/goal stop` | End automation without touching running work |
| `/goal continue` | Resume a stopped goal |
| `/goal clear` | Remove all stored state for the goal |

Replacing, clearing, and confirming a proposal all ask first. A goal belongs to
one session: `/clear` and `/new` open a session with no goal.

The label on the rule above the prompt shows the state and the goal text, in a
colour per state — active, stopped, blocked, completed, failed. The last two are
terminal and have to be replaced or cleared.

## How it continues

After every settled turn a fresh judge reviews the repository and returns one
verdict. It runs only when the goal is active, no managed worker is running, no
external trigger is waiting, no message is queued, and this turn is unjudged —
all of it event-driven, with no polling anywhere.

The judge reads; it never writes. It holds `read`, `bash`, and one verdict tool,
runs readonly whenever Sandbox is not `Off`, and is removed after each review.
Its verdict is one of three:

- **completed** — the goal ends, with the evidence it found.
- **blocked** — one question for you, and the goal waits for your answer.
- **incomplete** — one continuation message, delivered as the next turn.

The review appears as a row in the transcript the moment the turn settles, and
that same row is rewritten with the outcome, so the wait and its result never
occupy two places.

## Steering and stopping

An ordinary message steers a live goal and answers a blocked question; the
automation stays on either way. Cancelling a turn with `Esc` stops the goal too:
an abort still settles the turn, so otherwise the judge would review the work
you just stopped and continue it. `/goal continue` resumes.

`goalRetryLimit` bounds the loop. It counts consecutive `incomplete` verdicts,
defaults to 10, accepts 0 through 100, and 0 means no limit. Reaching a nonzero
limit fails the goal and shows the judge's latest reason.
