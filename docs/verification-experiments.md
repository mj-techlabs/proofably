# Verification experiments, version 1

The data/evaluation API lives in `src/contracts.js`; the fixed-harness Docker
runner lives in `src/function-runner.js`. The optional AI planner is a separate
layer described under Checkpoint 4. No TypeScript compilation is supported. The existing command-based CLI/report format remains available. The experiment `schemaVersion` and
result `schemaVersion` are independently versioned at 1.

## Schema

See `tests/fixtures/power-of-two/experiment.json` for a complete example.
`validateExperiment` is the executable schema validator; malformed data throws
`TypeError`. Additional fields are ignored in version 1 and have no semantics.

| Required field | Meaning and constraints |
| --- | --- |
| `schemaVersion` | Exactly `1` |
| `id` | Nonempty experiment identifier |
| `target.module` | Nonempty repository-relative module path; no absolute path, backslash, empty segment, or `..` segment |
| `target.export` | Nonempty named export |
| `arguments` | Array of JSON values; finite numbers only; no undefined, sparse arrays, cycles, or class instances |
| `contract.id` | Nonempty predicate identifier; unknown identifiers are valid but unsupported |
| `contract.provenance.source` | Nonempty source reference for the explicitly supplied contract |
| `contract.provenance.statement` | Nonempty human-readable requirement |
| `expectedExecution.runtime` | Exactly `"node"` |
| `expectedExecution.timeoutMs` | Integer from 1 to 300000 |
| `expectedExecution.expectedExitCode` | Exactly `0` |

The Docker runner applies the timeout to each container attachment, including
startup and archive extraction. Docker control operations and Git operations have
eight-second limits, further clamped by the overall deadline; cleanup commands
have four-second limits. It resolves the target real path inside `/work` to
reject escaping symlinks. It does not verify provenance.
Provenance records the caller's source attribution, not independently established
authority. The contract ID selects the predicate; the statement is never parsed
or executed and must describe the selected predicate's intended applicability.

## Fixture contract

`smallest-power-of-two-gte` accepts exactly one positive JavaScript safe integer
`n` and requires a numeric result equal to the smallest power of two >= `n`.
For `Number.MAX_SAFE_INTEGER`, the result is `2 ** 53`, an exactly representable
number even though it is outside the safe-integer input domain. No bitwise
operations or floating-point logarithms are used by the oracle.

The fixture's `base.js` and `candidate.js` are alternative contents of the logical
target `index.js`, not actual Git revisions. The candidate changes `<` to `<=`.
At input `8`, base returns `8` and candidate returns `16`. Unit tests import these
trusted fixtures directly; they do not demonstrate isolated Docker execution.

## Observations and verdicts

`evaluateVerification(experiment, base, candidate)` accepts observations of the
form `{ "exitCode": 0, "timedOut": false, "value": 8 }`. A missing/non-JSON value,
nonzero exit, timeout, or malformed observation is unverified. The caller must
provide trustworthy observations; the evaluator cannot authenticate execution.

The result retains both observations and separates:

- `comparison`: `no-difference`, `behavioral-difference`, or `unverified`, based on
  structurally equal JSON return values. Object key order is irrelevant; array
  order matters. This is separate from the legacy CLI's stdout/stderr comparison.
- `contracts.base` and `contracts.candidate`: independently contain `satisfied`,
  `confirmed-contract-violation`, `unsupported-contract`, `invalid-input`, or
  `unverified`. Successful evaluations also record `expected` and `actual`.

Unsupported contracts and out-of-domain arguments cannot confirm a violation.
For a supported contract and valid input, a successful JSON result of the wrong
type is a violation. Infrastructure failures cannot establish one. Comparison is
independent: identical results can violate the contract in both revisions, and
an unexplained difference cannot itself confirm a defect.

## Limits and design tradeoffs

`confirmed-contract-violation` means only that the supplied successful observation
violates this built-in predicate for this input, assuming the explicit contract
applies. It does not establish requirement authority, reproducibility, a regression,
repository correctness, or security. The Docker runner now requires consistent fresh-container repetitions (three by
default). It still does not authenticate evidence against a malicious target.
A satisfied verdict covers only the observed input. Base behavior is never the
oracle. No AI output or generated assertion can select an executable expression.

A fixed predicate registry and runtime validation keep this checkpoint small and
dependency-free. A contract DSL or generated executable oracle would offer more
flexibility but increase the trusted execution surface and risk circular evidence.
Keeping the new API separate avoids changing legacy CLI semantics. Repetition and versioned evidence bundles are described below; signatures and
stronger isolation remain later work.

## Docker execution (Task 2)

Requirements: Node.js 22+, Git, a running Docker daemon, and a locally installed
Node 22 Alpine image. Install the image explicitly; the runner never pulls images:

```sh
docker pull node:22-alpine
node --test tests/function-runner.integration.test.js
npm test
```

The integration tests create disposable local Git repositories from the trusted
fixture files and commit base/candidate variants without modifying this repository.
They verify the 8-to-16 regression, exceptions, invalid/async outputs, timeouts,
output limits, log separation, missing exports, escaping symlinks, abrupt worker
exit, missing images, and container removal. Docker-unavailable tests are explicitly
skipped; missing images with an available daemon fail. Override the test image with
`PROOFABLY_TEST_IMAGE` (a locally installed Node 22 Alpine-compatible image).

For a repository containing the same exported function in both Git revisions:

```sh
node /path/to/proofably/src/function-cli.js \
  --repository /path/to/target-repository \
  --base <base-ref> --head <candidate-ref> \
  --experiment /path/to/proofably/tests/fixtures/power-of-two/experiment.json \
  --output function-report.json
```

The separate entry point avoids changing the legacy `src/cli.js check` interface.
An optional `--image <local-image-or-digest>` selects the trusted runtime. CLI
success means a report was produced; inspect comparison and verdict fields to
understand the evidence. Invalid options, schema, or Git revisions fail before
execution. Docker failures are recorded as unverified observations in the report.

The programmatic equivalent is:

```js
import { verifyFunctionExperiment } from './src/function-runner.js';
const report = verifyFunctionExperiment({
  repository: '/path/to/repository', base: 'main', candidate: 'HEAD', experiment,
});
```

### Execution and evidence

Both refs resolve to immutable commit SHAs before execution. The runner resolves
the selected local image to an immutable image ID once and uses it for both runs.
Reports include the resolved revisions, image ID, experiment, harness SHA-256,
per-observation Node/platform/architecture metadata, bounded logs, and cleanup
status. A mutable default tag is convenient locally; select a digest and preserve
the corresponding image for replay on another machine. Runs are not claimed to be
bit-for-bit reproducible across different architectures or Docker configurations.

Each revision is a Git archive extracted into its own non-root container's tmpfs.
Only a temporary input directory containing the archive, identical trusted harness,
and experiment JSON is mounted, read-only. No host working tree, credentials, or
Docker socket is mounted. The fixed bootstrap command contains no experiment text.
The harness imports one named function from a `.js` or `.mjs` target, passes JSON
arguments, and accepts synchronous JSON-compatible returns only. Dependency-free
modules are the supported scope; no install/build step runs. Imports do execute
module initialization code. Promises, undefined, nonfinite numbers, BigInt, cycles,
and non-JSON objects are invalid outputs.

A supervisor worker arrangement routes ordinary target stdout/stderr to diagnostic
stderr, keeping the JSON envelope separate. Function exceptions, target-loading
errors, invalid outputs, premature worker exits, timeouts, output overflow,
protocol errors, and Docker infrastructure failures have distinct `kind` values.
Only `returned` observations contain a `value`; other outcomes remain unverified
under the unchanged contract evaluator. A normal but contract-violating numeric
return is still a confirmed violation under Checkpoint 1's limited semantics.

The shared Docker policy disables networking, drops capabilities, sets
no-new-privileges, restricts CPU/memory/processes, and uses a read-only root
filesystem with bounded writable tmpfs mounts. The new runner also disables swap,
limits file descriptors and captured output (1 MiB), and never pulls an image.
Every attempt explicitly force-removes its uniquely named container, including
timeout and output-limit cases; cleanup is checked with a subsequent container
inspection. A failed cleanup invalidates confirmation while preserving the raw
observation and reporting the container name for manual removal. Per-container Docker log storage is
disabled. The legacy runner shares the isolation options; `/work` now explicitly
belongs to UID/GID 1000 so its existing non-root execution can extract archives.
Legacy CLI arguments, comparison semantics, and report shape are unchanged.

### Security and scope limits

Docker is a development isolation mechanism, not a hardened boundary for hostile
repositories. Use disposable machines for untrusted code. A worker isolates the
result channel from ordinary logging but is not an evidence-authentication boundary
against deliberately malicious Node code (which can access worker messaging or
Node internals). No claim of malicious-code tamper resistance is made.
Filesystem/path restrictions are defense in depth, not a JavaScript capability
sandbox. Resource caps do not prove purity: time, randomness, module side effects,
and process scheduling can still affect results. Dependency-free, deterministic
functions are an input assumption, not a statically verified property.

Cleanup is attempted synchronously with bounded Docker commands. Host crashes,
SIGKILL of the verifier, or daemon outages may prevent removal; use the recorded
`proofably-*` container names to investigate. Stronger isolation and self-contained source/image distribution remain outside
Checkpoint 3.

## Repetition and evidence (Checkpoint 3)

The existing function CLI and `verifyFunctionExperiment` interface still work.
The default is now **three fresh containers per revision**, with `repetitions`
configurable from 1 to 5. `overallTimeoutMs` defaults to 180000 and accepts
1000–300000 ms. CLI equivalents are `--repetitions` and `--overall-timeout-ms`:

```sh
node src/function-cli.js --base main --head HEAD --experiment experiment.json \
  --repetitions 3 --overall-timeout-ms 180000 --output evidence.json
```

The overall budget covers Git resolution, image inspection, archives, container
creation/execution and cleanup. Each attempt reserves eight seconds for bounded
removal and inspection; budgets below that cannot start a container. Attempts
that cannot start within budget are recorded as `budget-exhausted`, never as a
successful run or successful cleanup. OS scheduling/filesystem stalls are not a
hard real-time guarantee, and killing the verifier can still prevent cleanup.

`src/contracts.js` and its predicate/verdict semantics are unchanged. A new
reproduction layer independently gates each revision's verdict:

- Every required attempt must return successfully with verified container removal.
- Results must be exactly structurally equal, with types and array order retained;
  object key order is irrelevant. `0` and `-0` remain distinct in transport and
  evidence text. No output normalization or numeric/string coercion is applied.
- Diagnostic stderr hashes, source archive hashes, and runtime metadata must agree.
- Any failure or inconsistency gives that revision an `unverified` verdict with
  a reason such as `execution-failed:timeout`, `cleanup-not-verified`,
  `inconsistent-results`, `inconsistent-logs`, or `inconsistent-source`.

A base failure does not erase a stable candidate violation. Comparison needs two
stable sides and is otherwise `unverified`. Unlike the earlier function runner,
behavioral comparison also exposes diagnostic log differences: matching return
values with different stderr hashes are a `behavioral-difference`. This does not
change the built-in contract predicate. Overall `classification` is
`confirmed-contract-violation` if either revision independently confirms one;
otherwise it is `unverified` if a revision's verdict is unverified, or the
behavioral comparison. Consult the independent verdicts to identify the affected
revision; an overall confirmed violation is not automatically a new regression.
Setting repetitions to 1 explicitly reduces the reproduction requirement to one.

### Evidence format

`serializeEvidence` and `validateEvidence` in `src/evidence-bundle.js` define the
versioned JSON format. The root has `kind: "proofably-evidence"`, `bundleVersion: 1`,
and the retained `schemaVersion: 1` compatibility field.

| Field | Recorded data |
| --- | --- |
| `experiment` | Defined schema fields only, including contract ID, statement and source attribution |
| `revisions` | Exact base/candidate commit SHAs, never branch names |
| `execution` | Requested image, resolved immutable image ID, settings, and SHA-256 hashes of the harness, JSON transport helper, runner policy, runner source, evaluator, and reproduction evaluator |
| `attempts.base`, `attempts.candidate` | Every required attempt, including failures and unexecuted budget placeholders |
| Per attempt | Outcome, value when returned, exit/timeout/signal/error information, runtime metadata, source archive hash, bounded logs and their hashes, truncation flags, and cleanup records |
| `cleanup` | Whether attempted, unique container name, verified removal state, and bounded removal/inspection process results; unattempted removal is `null`, not success |
| `reproduction` | Per-revision consistency, reason when unverified, required/returned counts and verdict |
| `contracts` | Independent per-revision verdicts (gated by reproduction) |
| `comparison`, `classification` | Behavioral comparison and overall classification |
| `observations` | Compatibility representatives: first attempt only when stable; an unverified representative otherwise. Use `attempts` for complete evidence. |

The runner limits captured process output to 1 MiB. Each stored stream preview is
at most 64 KiB, with a SHA-256 hash of all captured raw bytes, so differences beyond
the readable prefix remain detectable. Non-UTF8 preview replacement is flagged as
truncated/lossy; hashes still distinguish the raw bytes. Output overflow invalidates
the attempt. Experiments are bounded to 1 MiB and evidence files to 32 MiB; JSON
nesting is bounded. Use `serializeEvidence` rather than ordinary `JSON.stringify`
to preserve negative zero. JSON text can be read independently of Node runtime
objects; no Error instances, Buffers, environment dumps, credentials, source
archives, or unrelated experiment metadata are embedded.

No host environment is copied into containers or reports beyond Docker's own
required connection context on the host. Arguments, provenance, errors and target
logs are intentionally preserved; callers must not put secrets in those inputs or
in a custom runner image. Arbitrary target text cannot be reliably secret-redacted
without changing evidence. Evidence files are created with owner-only permissions
(the existing file's permissions are retained when normal verification overwrites
an existing output). Source archives include the selected committed revision for
execution but are deleted from temporary storage and never embedded in evidence.

### Execution replay

```sh
node src/function-cli.js replay --bundle evidence.json \
  --repository /path/to/the-same-repository --output replay.json
```

Replay validates bounded JSON, versions, experiment fields, immutable identities,
execution settings, attempt counts/types, log metadata and cleanup claims before
using execution inputs. It treats original observations and summaries as untrusted
claims. It verifies required installed artifact hashes and executes the recorded
experiment again against the exact recorded SHAs and image ID, using the recorded
repetition count and budget. It never pulls images, substitutes a tag or HEAD,
loads executable code from the bundle, installs dependencies, or calls a model.
The repository location is explicitly supplied at replay time and is not embedded
as a machine-specific path in the bundle.

A missing commit/image or unavailable/different installed harness, transport,
runner, or evaluator fails safely. Images and Git objects must still be available
locally; this format is evidence plus execution inputs, not a source/image archive.
Source archive hashes also make differences in archive construction visible in
replay comparisons. A matching image ID normally requires the same platform image;
different recorded runtime metadata is reported as a mismatch.

Replay produces a separate wrapper with `replayVersion: 1`,
`mode: "execution-replay"`, the original bundle's canonical SHA-256,
per-revision observation/verdict/consistency checks, comparison/classification
checks, a stored-summary consistency check, and new `evidence` when execution was
possible. `status` is `match`, `mismatch`, or `infrastructure-failure`; unavailable
artifacts/commits can leave `evidence: null` with an error. Timeout/exception or
inconsistent results are preserved in the new evidence and cannot acquire a
confirmed verdict. Random container names and cleanup command text are not treated
as behavior; results, diagnostics, errors, execution status, runtime, archive
identity, and cleanup success are compared. Original derived summaries and
compatibility observations are also recomputed to expose inconsistent claims.

This is **execution replay**, not merely reevaluating saved observations.
`summarizeReproduction` can reevaluate stored data, but cannot independently prove
that it ran. Hashes identify artifacts and expose mismatches; they do not sign or
authenticate evidence. A malicious party can forge a self-consistent bundle.
A replay `match` means the recorded observations/verdicts were reproduced, not
that the contract is authoritative or the function correct for all inputs.

Replay output uses exclusive creation, refusing any existing output path,
including aliases/hardlinks/symlinks to the original. If `--output` is omitted,
a fresh UUID-based filename is chosen. The original file is never overwritten.
Exit status is zero only for `match`; mismatches and infrastructure failures write
a report and exit nonzero. Malformed input exits nonzero before execution.
Older Checkpoint 2 reports lack the necessary version/attempt/artifact fields and
are rejected for replay; the legacy command CLI remains unchanged.

### Local validation

```sh
docker pull node:22-alpine
npm test
# Only Docker integration checks:
node --test tests/function-runner.integration.test.js
```

The first Docker integration case builds disposable fixture Git commits, saves
three base=8 and candidate=16 observations, replays that saved file through the
CLI in six new containers, verifies the same verdict, and checks the original is
unchanged. Other integration cases cover stable matching results, inconsistent
container-dependent results, transport fidelity, and existing runner/CLI failures.
Unit tests cover deadline enforcement, independent verdicts, cleanup failures,
tampering/mismatches, missing revisions/images/artifacts, and hostile/malformed
bundle inputs. Docker-unavailable checks explicitly skip; a reachable daemon with
missing images fails. No tests require a model, model credentials, or network
access inside an execution container.

## AI-generated experiments (Checkpoint 4)

The new `node src/function-cli.js ai` mode adds input discovery around the existing
execution pipeline. The supported host runtime is now Node.js 22+, matching the
official OpenAI SDK 7.57.0; package metadata and setup instructions reflect this
explicit runtime compatibility change. Manual function verification, the legacy command CLI,
contract semantics, and bundle version 1 remain intact. Each generated case is a
normal experiment and normal replayable evidence bundle. No contract discovery,
repository-wide analysis, original-agent integration, or generated program is used.

### Provider boundary and context

A planner exposes `async proposeExperiments(context, budget)` and returns
`{ cases, provenance }`. The fixture planner is an offline deterministic provider;
the OpenAI provider uses the pinned official JavaScript SDK and Responses API.
The default model is `gpt-6-luna`; `--model` overrides `PROOFABLY_MODEL`, which
overrides the default. Only models in the reviewed pricing/token-bound registry
are admitted. The adapter fixes the endpoint to `https://api.openai.com/v1` and
disables SDK logging, tools, automatic retries and response storage (`store: false`).
`store: false` is not a claim of zero service-side retention or zero billing.

The existing `--experiment` document supplies the explicit module/export,
contract/provenance, and execution timeout. Its arguments are a compatibility
placeholder: AI mode replaces them and never sends them, its experiment ID,
previous findings, or known-trigger examples to the model. Provenance statements
must describe the selected built-in contract; their applicability remains the
caller's responsibility.

Both refs resolve to commits before generation. Only regular Git blobs are read;
target symlinks/reexports/missing functions fail closed. Acorn parses each bounded
module without running it, selecting only the requested function declaration,
function-valued variable, or locally aliased named export. Async/generator targets
are rejected. No imported helper or other file is fetched for model context.
The selected-function diff is a deterministic replacement diff of those two
excerpts, not a whole-file diff containing unrelated hunks. Module parsing is
limited to 64 KiB per revision, function excerpts to 4 KiB each, contract data to
4 KiB, and total serialized planning context to 16 KiB. Overflows fail rather than
silently disclose/truncate unrelated code. Missing helpers may reduce planner
quality; automatic helper discovery is deliberately deferred.

Source, comments, diff and model text are untrusted data. Developer instructions
explicitly tell the model not to follow embedded instructions. This instruction
alone is not a prompt-injection guarantee: the deterministic boundary is the
restricted schema and independent local validation. A model cannot choose another
target, change the contract, request tools, or provide executable code/commands,
harnesses, assertions, or expected outputs. Rationale is untrusted commentary,
never evidence authorizing a verdict.

### Generated-case format and limits

```json
{
  "cases": [
    {
      "arguments": [4],
      "contractId": "smallest-power-of-two-gte",
      "rationale": "Boundary input."
    }
  ]
}
```

This is an illustration, not a seeded example in the generation prompt.
The API uses strict `text.format` JSON Schema with no additional properties.
Local validation independently rejects malformed shapes, extra fields (including
`target`, `code`, `expected`, `command`), unknown contracts, duplicate cases,
unsupported argument types, excessive depth, sizes, or counts. Rationale may be
omitted/null locally; the strict API schema represents it as a required nullable
field. No generated string is dynamically evaluated.

This checkpoint has one accepted contract and therefore one argument-domain shape:
exactly one positive safe integer. These are JSON argument arrays, but arbitrary
object/string contracts are not implemented. A wrong string return from the target
can still violate the numeric contract; a model-supplied string argument is rejected
before execution because it is outside the accepted domain.

| Limit | Default / maximum |
| --- | --- |
| Generated cases | 5 / 8 |
| Argument serialization | 4 KiB (the current numeric domain is much smaller) |
| Generated JSON depth | 4 |
| Rationale | 512 UTF8 bytes |
| Generated text | 64 KiB |
| Entire HTTP response, including metadata | 128 KiB |
| Output token cap, including reasoning | 2048 / 4096 |
| Input token estimate budget | 32768 / 65536 |
| Total token estimate budget | 34816 / 69632 |
| Request timeout | 30000 / 60000 ms |
| API requests / retries | 1 / 0 |
| Estimated cost budget | $0.02 default; explicit positive value up to $10 |
| Shared overall runtime | 180000 / 300000 ms |

Flags are `--max-cases`, `--max-output-tokens`, `--max-input-tokens`,
`--max-total-tokens`, `--request-timeout-ms`, `--max-cost-usd`,
`--overall-timeout-ms`, `--repetitions`, and `--image`. Raising a model/case budget
does not automatically raise another budget. The overall clock includes context,
image inspection, generation, and every case's bounded execution. Each case gets
only the remaining time; missing budget gives unverified cases/placeholders rather
than silently dropping generated inputs. Existing container cleanup reservations
still apply. A refusal, incomplete/truncated response, timeout, wrong model,
malformed output, or API error has no fallback request and creates no executions.
SDK exceptions are replaced by fixed error codes, not copied into artifacts.

### Token and cost preflight

Rates were checked against [OpenAI pricing](https://developers.openai.com/api/docs/pricing)
on 2026-11-15. Prices below are USD per million text tokens, standard tier:

| Model | Standard input | Output | Conservative input reservation |
| --- | ---: | ---: | ---: |
| `gpt-6-luna` | 0.10 | 0.50 | 0.25 |
| `gpt-6.1-sol` | 2.00 | 10.00 | 5.00 |
| `gpt-6.1-terra` | 1.00 | 5.00 | 2.50 |

The conservative input rate reserves the documented 12-hour cache-write rate for
all input, and ignores cache discounts. Input estimation charges one token per
UTF8 byte of the serialized request (including instructions and schema), plus
4096 framing tokens. The maximum output allowance is then added and priced,
including possible reasoning tokens. All three preflight budgets (input tokens,
total tokens, USD) must pass before a request. Text-only known models with reviewed
byte-token estimates are admitted; unknown model pricing/token bounds fail closed.
These are deliberately conservative application estimates, not server-enforced
input-token caps. The model windows comfortably exceed the application's bounds;
long-context pricing thresholds are outside these allowed inputs.

Pricing entries expire on 2026-12-15 and then reject requests until the source
registry is reviewed/updated. A different configured model may require a larger
explicit USD budget. No automatic pricing fetch or extra token-count API request
is made. The pricing snapshot and preflight calculation are preserved in provenance.

Actual API input/output tokens, available cache/reasoning counts, a conservative
cost estimate from actual tokens, and a standard-input/output comparison estimate
are recorded when reported. Missing usage stays `null`; timeout/error does not
mean a request was free. A response exceeding reported token/cost budgets is
rejected before executing its proposed cases, while retaining its usage metadata.

**Application-side cost controls are estimates, not guaranteed billing hard
stops.** Cancellation may occur after server processing or billing; hidden
framing, changed rates, account-specific charges, taxes, and external requests
are not controlled here. Use account-level provider controls as well. There are
no model tools, retries, or automatic follow-up requests in this implementation.

### Artifacts, provenance and replay compatibility

AI mode exclusively creates a new output directory (default
`proofably-ai-<uuid>`). Existing directories, including symlink aliases, are
rejected. Files are owner-only and created exclusively:

- `planning.json`, `planningVersion: 1`: selected target/contract, resolved SHAs,
  context hash, validated generated cases/rationales, provider/model, prompt version,
  request hash, pricing/preflight, request count and available usage/cost.
  Raw source context, SDK client, API response envelopes, headers and keys are not saved.
- `case-001.json`, etc.: unchanged version-1 execution evidence, with the generated
  arguments, explicit contract provenance, repetitions, cleanup and verdicts.
- `manifest.json`, `aiRunVersion: 1`: hashes linking planning and case files,
  generated inputs, per-case outcomes, counts, partial failures and sanitized errors.

Summary counts expose confirmed violations, unexplained behavioral differences,
unverified cases, and no differences. An independently confirmed candidate with
an unverified base counts in both confirmed and unverified totals; run status is
`partial`, and independent verdicts remain visible. A model's rationale does not
change classification. Cases failing setup/evidence writing remain unverified;
earlier evidence files are retained. Planning is saved before executions begin.

Replay a per-case bundle with the existing command:

```sh
node src/function-cli.js replay --bundle proofably-ai-example/case-001.json \
  --repository /path/to/target-repository --output replay.json
```

Replay does not load the planner, require model credentials, or call OpenAI.
The manifest and planning sidecar are not execution bundles and are not accepted
as `--bundle`. Keep them alongside case files to retain generation provenance;
a case bundle alone still contains every input needed for execution replay.
Experiment/bundle version 1 and contract verdict semantics do not evolve here.
The runner now strips `OPENAI_*` variables even from the host Docker CLI process;
containers receive no host environment, model key, credentials or Docker socket.
The runner-source hash therefore changes. As already required by Checkpoint 3,
old bundles need their matching installed runner artifacts; no compatibility check
is bypassed to replay them with modified tooling.

`OPENAI_API_KEY` is read only from the environment. No key argument, config file,
`.env` loader, logging, or persistence path is provided. Explicit AI mode sends
selected source and contract data to OpenAI; review selected code for secrets
before opting in. Arbitrary source strings and generated rationale are not a
reliable automatic secret-redaction boundary. Docker remains development
isolation, not a hardened boundary for hostile repositories.

### Offline tests and opt-in live demonstration

```sh
npm ci
npm test
node --test tests/ai.integration.test.js
```

Unit tests use fixture proposals, mocked Responses objects and mocked SDK HTTP;
ordinary tests do not make model calls even if a key exists. Docker tests use the
fixture provider to generate `[4]` and `[5]`, reproduce the boundary violation,
exercise partial failures, and replay ordinary bundles without a model.

The separate live test requires explicit opt-in, `OPENAI_API_KEY`, Docker, a local
runner image, and reviewed pricing:

```sh
# OPENAI_API_KEY is already exported securely.
PROOFABLY_LIVE_API_TEST=1 npm run test:live
```

It makes at most one request, supplies no known triggering argument to the model,
and asserts a generated case reproduces a candidate violation with a satisfied
base. Failure to discover a case is reported as a test failure, not replaced by a
fixture or another paid request. Diagnostics record the selected model, actual
usage/cost when available, generated inputs, summary, evidence directory, and the
retained temporary fixture repository needed for later replay. Set
`PROOFABLY_LIVE_OUTPUT_DIR` to choose a new artifact directory. Without opt-in or
credentials, the demonstration explicitly skips and cannot be claimed as passed.
