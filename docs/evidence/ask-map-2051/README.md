# Ask this map live qualification

This directory retains actual authenticated model calls and independent semantic
results for the ten-case synthetic incident acceptance corpus. It is bounded
sample evidence, not a general natural-language accuracy benchmark. Earlier
failures remain visible alongside the qualified run; they are not substituted
with recorded answers. Experimental API promotion remains a separate decision.

The engineering review on 2026-10-12 requires 6/6 supported results, 4/4 safe
clarification/refusal outcomes, zero unsafe executions or exposed provider
credentials, and at most 15,000 ms per case. The fixture IDs/counts were committed
before the live calls and do not enter the model prompt. Each case uses the same
schema admission, semantic compiler, prepared DuckDB execution, and receipt path
as the sample. Recorded replay is reported separately.

## Provenance and verification

`index.json` joins each evaluated SDK commit, sample harness digest, external
provider bridge digest, and SHA-256 of every retained artifact. The exact bridge
sources are stored with a `.txt` suffix only to avoid treating historical copies
as executable project code. The bridge adapts the public fixture's provider-neutral
callback to Bedrock Messages, with the existing ambient AWS credential chain.
It runs locally behind the sample's authenticated HTTP adapter; application
sessions are random, HttpOnly cookies. No provider key is present in the browser.

The requested Bedrock inference profile and actual returned model are distinct
fields in provider provenance. Request IDs identify actual provider calls. The
first provider-rejected schema run returned no model; its older `actualModel`
field is explicitly disqualified in the index. Synthetic generated query
arguments are retained to explain semantic failures, but private prompt histories, credentials, session values, AWS account identifiers
and private data are absent. A public-fixture-only native diagnostic request and
response are retained to establish that Sonnet produced a string before bridge
conversion. Schema preflights are configuration diagnostics, not corpus passes.

To verify a bridge digest, hash the UTF-8 string `invoke.py`, its retained bytes,
then `run.mjs`, its retained bytes, in that order. To verify the SDK harness,
check out `evaluatedSdkCommit` and run the exported `evidenceIdentity()` in
`examples/nl-map-control/evidence-identity.mjs`. Its hash covers the ordered sample
query/model/runtime/evaluator/fixture/corpus/HTTP-adapter files. The SDK commit
also binds the shared control, compiler and driver. Follow-up evidence-only
commits do not imply a new live execution; source equivalence is recorded
explicitly instead of making an impossible receipt self-hash claim.

## Results

The qualified configuration is **Bedrock Haiku 4.5**, requested through
`us.anthropic.claude-haiku-4-5-20251001-v1:0`, with actual returned model
`anthropic.claude-haiku-4-5-20251001-v1:0`, on **Node 22.23.3 / Linux x64**.
Run 10 evaluated clean commit `a3e3412fd816cf9069a05395f9fc4787d591f0e0`:
6/6 supported cases, 4/4 clarification/refusal controls, zero unexpected
executions, no latency failures; median 4,182.1 ms and maximum 10,372.5 ms.
The distance refinement used two model attempts; other supported cases used one.
The prior model attempts and subsequent semantic SQL execution are separately
visible in provider provenance and the evaluation receipt.

| Run | Configuration / observed limitation | Supported | Safe | Outcome |
| --- | --- | ---: | ---: | --- |
| 01 | Haiku, original broad schema | 2/6 | 4/4 | Failed |
| 02 | Haiku, diagnostic repeat | 2/6 | 4/4 | Failed |
| 03 | Haiku, top-level schema rejected by provider | — | — | No accepted model response |
| 04 | Haiku, static narrowed schema, lost refinement scope | 5/6 | 4/4 | Failed |
| 05 | Haiku, widening rejected, unnecessary clarification | 5/6 | 4/4 | Failed |
| 06 | Sonnet, expected/actual model identity mismatch | — | — | No execution admitted |
| 07 | Sonnet, serialized query strings | 0/6 | 4/4 | Failed, including latency failures |
| 08 | Sonnet, explicit object wording, still strings | 0/6 | 4/4 | Failed, including latency failures |
| 09 | Haiku, clarified retry context, still lost scope | 5/6 | 4/4 | Failed |
| 10 | Haiku, schema constrained to actual accepted context | 6/6 | 4/4 | Passed |

Runs 01–09 used Node 20.19.0 and are historical diagnostics. Run 10 uses the
approved Node 22 baseline. This does not qualify Sonnet, other providers, arbitrary
prompts, geodesic distances, or sources beyond the admitted sample. The improved
schema derives its constant filter solely from the previously accepted query;
it contains no corpus expected IDs/counts and the host never rewrites a proposal.

`qualified-source-files.json` fixes the complete SDK source and sample input
bytes at the evaluated parent. The commit retaining this evidence changes only
documentation/evidence; it does not claim to evaluate its own receipt bytes.
`recorded-a0abbd/` is the earlier separate 10/10 recorded browser run, explicitly
labelled with its own source identity; it is not live-provider evidence.

`recorded-a3e341-node22/` is the final separate Node 22 Chromium workflow and
10/10 recorded corpus on the same clean source as the qualified live run.
