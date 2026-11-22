# Byte deltas with PingRoom

Build a byte patch after an owner identifies the currently installed baseline. Code finds reusable byte ranges, emits COPY and LITERAL operations, and verifies that the selected baseline reconstructs the exact target.

Use this between a bounded artifact export and a transfer or installation tool. This starter writes local JSON only. It does not send bytes, install software, or overwrite the supplied snapshots.

## Try it offline

Choose **Use this template**, clone your copy, and use Node.js 22 or newer:

```sh
npm ci
npm test
npm run demo
```

The fictional catalog demo covers a matching baseline, an empty baseline and Unknown. Tests and demos use published `@pingroom/sdk` 0.8.0 through local mock transports. After installation, they need no credentials or network and send no live pings. Dependencies are pinned in the lockfile; `.npmrc` requests a 14-day release age where supported by npm.

## Prepare snapshots

```sh
cp examples/delta.json delta.json
cp config.example.json config.json
npm run preview
```

Adapt `delta.json` to your artifact export:

| Field | Contract |
| --- | --- |
| `transferId` | Stable ID, 1–40 characters: lowercase letter first, then lowercase letters, digits, `_` or `-`. |
| `title`, `context` | Nonempty single-line descriptions without surrounding whitespace, at most 40 and 80 UTF-16 code units. |
| `targetHex` | Target bytes as even-length hexadecimal, without spaces or a prefix; 0–2048 bytes. |
| `baselines` | 1–3 candidate snapshots with distinct IDs, labels and byte contents. |
| Baseline `id` | The ID alphabet above, at most 12 characters; `unknown`, `constructor` and `prototype` are reserved. |
| Baseline `label`, `reference` | Already-trimmed single-line text, at most 24 and 40 UTF-16 code units. The reference should identify a retained version record. The label `Unknown` is reserved, regardless of case. |
| Baseline `hex` | Candidate installed bytes in the same format and size range as `targetHex`. |

Hex is case-insensitive on input and normalized to lowercase. Empty snapshots are valid. Metadata cannot contain control/format characters or malformed Unicode. Extra fields, sparse arrays, malformed hex, duplicate candidates and inputs over 64 KiB are rejected. The full visible Question must fit 500 UTF-16 code units; preview checks this before any request.

An adapter can read a small artifact with Node's `readFileSync(path).toString('hex')`. Keep the bytes and their version references together. This starter does not discover installed files or infer their version from a filename.

## Connect and select the installed baseline

Install [PingRoom](https://pingroom.io/i), then:

```sh
npm run connect
npm run inspect
```

Approve pairing and grant a standard private room containing the installed-version owner, with room-list and Question create/read permissions. Verify the person in the app and enter their exact member UUID and a descriptive label in `config.json`. Names alone do not establish identity.

For an existing granted connection, copy `.env.example` to `.env` and set **both** `PINGROOM_TOKEN` and `PINGROOM_ROOM`. Blank or partial pairs are rejected; credential sources cannot be mixed.

```sh
npm run preview
npm start
# After the owner answers:
npm start
npm run export
```

Each run creates at most one direct, 15-minute Question or reads the original Question once. The owner selects a supplied baseline from the installed-version record, or **Unknown**. Unknown, missing, expired, cancelled, invalid or misattributed answers block patch export. There is no replacement Question or background polling.

PingRoom receives the transfer ID, title/context, candidate labels and references, owner UUID, and input/target/policy hashes. Snapshot bytes stay local. Preview shows the full local input and the exact visible Question.

## Read, export and reconstruct

```sh
npm run status
npm run report
npm run export
cp examples/baseline.json baseline.json
# Replace baseline.json with the actual retained baseline: {"hex":"..."}
npm run reconstruct -- baseline.json
```

These commands are local and need no credentials. `report` writes private `.delta/report.json`, including all source snapshots and answer evidence. Completed `export` writes `.delta/patch.json` with two parts:

- `patch`: baseline and target byte lengths and SHA-256 hashes, plus COPY/LITERAL operations.
- `evidence`: source/policy hashes, baseline ID, attributed answer and byte counts.

The handoff omits the complete input manifest and baseline snapshots. Literal operations can contain the entire target when no reusable range exists; it is not a redaction format.

`reconstruct` reads that saved handoff and an explicit baseline JSON containing only `hex`. It checks the exact baseline size/hash, interprets the bounded operations, and checks the resulting target size/hash before atomically writing private `.delta/reconstructed.json`. It never installs bytes or changes the baseline input. The baseline cannot be the reconstruction output, including a path alias. A failed check leaves any previous reconstruction artifact intact; inspect the current command's exit status.

Reconstruction verifies content against the supplied patch. It does not independently authenticate the patch publisher or its copied owner evidence. Retain the expected target digest through your own trusted release process if authenticity matters.

## Encoding rules and limits

At each target position, the encoder chooses the longest matching range anywhere in the baseline. Equal-length matches use the lowest baseline offset. Matches of at least four bytes become `COPY {offset,length}`. Bytes before the next qualifying match coalesce into `LITERAL {hex}`. Offsets and lengths are bytes. Copies read only the supplied baseline, never earlier output; repeated and backwards copies are valid.

The implementation uses a two-row dynamic program with at most 2048 × 2048 byte comparisons per selected baseline. The interpreter accepts at most 2048 operations, rejects invalid fields and out-of-bounds copies, and refuses output beyond the declared target size. Empty targets produce no operations. The encoder also runs the interpreter and compares exact bytes before returning a patch.

This greedy encoding is deterministic, not a minimum-size optimizer. JSON overhead can make the handoff larger than the original target. The format is a custom bounded JSON delta, with no VCDIFF, bsdiff or rsync interoperability. [RFC 3284](https://www.rfc-editor.org/rfc/rfc3284.txt) describes VCDIFF and its byte-copy instructions.

## Adapt and resume

Use `buildDelta(rawInput, baselineId)` in `src/model.js` to obtain a patch and byte counts. Use `applyDelta(patch, baselineHex)` as the pure standalone interpreter; it returns lowercase reconstructed hex. CLI export additionally requires the attributed baseline selection. Write your own adapter to deliver a verified patch and baseline to a trusted consumer; no transfer, deployment or installation adapter is included.

Real inputs, configuration, credentials, state and outputs are ignored by Git. Keep `.delta/` and `.pingroom/` private. Writes use an atomic rename under a local lock. Changed input, participant, room or credentials cannot reuse the session.

A lost creation response leaves `create_unknown` and never triggers an automatic resend:

```sh
npm run status
npm run find-id
npm run recover -- EXACT-QUESTION-UUID
```

Recover only the original Question. An empty bounded search does not prove creation failed. Resolve or revoke uncertain/expired pairing in Connected Agents before archiving its pending record. Remove a stale `.lock` only after confirming its process stopped. Keep the original source and session while resolving uncertainty.

Run commands serially. Exit codes: `0` complete/local result; `1` invalid setup/evidence or refused export/reconstruction; `2` incomplete/Unknown/failed answer; `3` ready/pending/interrupted; `4` uncertain creation. Local status/report return 0 even for incomplete states; inspect their JSON status.

Tests cover independent encoding and reconstruction, maximum inputs, repeated matches, malformed patches, wrong baselines, provenance, uncertain creation, pairing and real CLI subprocesses. GitHub Actions runs Node.js 22 and 24. Live phone delivery is not tested. MIT licensed.
