# OAuth2 sign-in example

A minimal browser app that signs in with **OAuth2 authorization-code + PKCE**
using `@honua/sdk-js/auth`, against a self-hosted mock identity provider.

- `mock-server.mjs` is the mock IdP: it exposes `/oauth/authorize` and
  `/oauth/token`, **verifies the PKCE `code_verifier` server-side** (S256), issues
  access + refresh tokens, and guards `/api/v1/whoami` behind a bearer token. It
  also serves the built example and runs standalone (`node mock-server.mjs`).
- `src/main.ts` wires `oauth2({ … })` into a `HonuaClient`, runs the redirect
  round-trip (`signIn()` → `handleRedirectCallback()`), and then calls the
  protected resource — the token is attached transparently by the client.

## Run

```bash
npm run demo:oauth-signin:mock   # start the mock IdP + serve the built app
# then open the printed http://127.0.0.1:<port>
```

or dev mode (uses the mock IdP for the auth endpoints — start it separately):

```bash
npm run demo:oauth-signin        # vite dev server
```

The Playwright smoke test (`test/playwright/oauth-signin.spec.mjs`) drives the
full redirect flow end to end.

See [`docs/auth.md`](../../docs/auth.md) for the full authentication guide.
