# Natural-language map control demo (deterministic, no API key)

Demonstrates `@honua/sdk-js/nl-map-control`: a canned instruction runs
through a **recorded fixture LLM** (the same recorded completions the unit
tests replay from `test/fixtures/nl-map-control/`), compiles into a
serializable plan rendered as JSON, and executes on a live MapLibre map only
after approval:

- read-only plans auto-execute under policy;
- viewport/mutation plans require a signed agent-safety approval envelope
  (a demo signer/verifier stands in for host-owned keys);
- every execution emits a receipt, shown next to the observed map effects.

```bash
npm run demo:nl-map-control          # dev server
npm run demo:nl-map-control:build    # production build
npm run demo:nl-map-control:typecheck
```

See [`docs/nl-map-control.md`](../../docs/nl-map-control.md) for the safety
model and API walkthrough.
