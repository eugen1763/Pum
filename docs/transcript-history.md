# Session transcript recovery

`history` reads only the calling execution context's session manager. It never
accepts paths, agent selectors or session selectors. It searches all retained
branches and context windows in newest-first append order, not timestamp order.
Private custom/structural entries remain unsearchable; explicit reads return
ancestry metadata and a placeholder, not private data. Existing Bash exclusions,
provider-signature withholding and image bounds remain unchanged.

## Search pages

```json
{"op":"search","query":"decision evidence","limit":10}
```

Continue with the returned `nextCursor` and the same case-insensitive literal query:

```json
{"op":"search","query":"decision evidence","cursor":"<nextCursor>","limit":10}
```

`nextCursor: null` means finished. `nextOffset` is diagnostic, not a search
continuation input. Only initial search offset 0 is accepted; any offset together
with a cursor, or a nonzero search offset without one, is rejected. Page limits
may change between requests. Restart a search without a cursor to include new
entries. The first snapshot can include the assistant call that requested it;
subsequent persisted calls/results cannot enter or shift that snapshot.

Cursors are at most 1024 characters, authenticated with HMAC-SHA256 under a random
per-registration key. Their bounded payload binds the version, hashed session ID,
folded-query hash, original prefix count and ordered ID/parent-ID digest, and next
matching-entry offset. Signature, shape, integer ranges, session, query and prefix
are validated before searching. Changing sessions, truncating/reordering/reparenting
its prefix, tampering, or mixing pagination interfaces fails with a restart-search
error. The key is constant-size runtime state: no cursor registry, cached
transcript, file access or companion persistence is added.

The installed SDK's `getEntries()` returns a shallow copy in append order. Its
stored entry contents are append-only. Explicit `new_context` appends a boundary
and reprojects the active messages, preserving the history registration and session
identity. Thus cursors survive in-runtime rollover and branch switching. A new
registration on runtime replacement or restart intentionally invalidates them,
even when reopening the same session. Retain entry IDs for durable recovery.

## Text and images

Read using `entryId`; continue exact normalized text with `nextOffset` as `offset`.
Offsets count UTF-16 code units, without trimming or newline conversion. Reads do
not accept search cursors. The initial read defaults to one image; nonzero text
offsets default to zero images unless `imageOffset` or `imageLimit` is explicit.
Use returned `nextImageOffset` explicitly to recover further images, independently
of text. Explicitly requesting an already-read image can reattach it; there is no
hidden attachment-consumption state. `imageLimit: 0` always requests text only.

Every serialized result contains the historical-data notice once, in its JSON
`notice` field. The ordinary tool `details` object mirrors that JSON for callers;
there is no additional notice prepended to model text.

## Capacity and limitations

History executes sequentially, so the controller includes earlier persisted
results in the same SDK batch. UTF-8 bytes / 3 plus 1200 tokens per attached image
remain conservative estimates, not provider accounting. Cursor bytes are included
in every fitting decision. Shrinking a page advances only by the results actually
returned. Refusal preserves its original snapshot and offsets in `nextCursor`;
retry after rollover. A minimal refusal itself can exceed an exhausted budget.
Unknown capacity uses static text/result/image caps; invalid known budgets refuse.

Search still scans the retained transcript prefix on each page; cursor validation
adds an O(entries) identity/ancestry digest. There is no result index or performance
claim for very large sessions. Identity checks detect prefix replacement/removal,
not arbitrary in-place mutation of stored message bodies with unchanged IDs and
parents. Such mutation is outside the SDK append-only contract; the cursor is not
an isolation boundary against extensions modifying SDK objects. Read offsets also
rely on immutable stored content. No cross-runtime continuation or image deduplication
registry is promised.

Regression coverage: `tests/transcript-history.test.ts`,
`tests/transcript-history-cursor.test.ts`, `tests/context-window-sdk.test.ts` and
`tests/context-window-regression-sdk.test.ts` exercise bounded recovery, privacy,
append-between-pages, cursor rejection, image defaults, capacity and actual SDK
rollover/result persistence. Tests use isolated fixtures, not live provider calls.
