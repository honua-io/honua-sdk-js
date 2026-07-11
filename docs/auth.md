# Authentication

`@honua/sdk-js` ships a small, pluggable authentication layer. A `HonuaClient`
accepts an **auth provider** that resolves credentials on demand; the client
attaches them to every request across **all transports** (REST fetch paths and
gRPC-web calls), refreshes them transparently before they expire, and force-
refreshes once on a replay-safe `401`/`403`.

```ts doc-test=compile
import { HonuaClient } from "@honua/sdk-js/honua";
import { oauth2 } from "@honua/sdk-js/auth";

const auth = oauth2({
  authorizationEndpoint: "https://idp.example/authorize",
  tokenEndpoint: "https://idp.example/token",
  clientId: "my-app",
  redirectUri: `${location.origin}/callback`,
  scopes: ["openid", "profile"],
});

const client = new HonuaClient({ baseUrl: "https://api.example", auth });
```

The auth providers live in the dedicated `@honua/sdk-js/auth` subpath so a
`HonuaClient`-only consumer never pays the PKCE / token-exchange code size. Only
[WebCrypto](https://developer.mozilla.org/docs/Web/API/Web_Crypto_API) is used
for PKCE, so there are **no new runtime dependencies** (Node ≥20 exposes
`globalThis.crypto`).

## Built-in providers

| Provider | Import | Use | Interactive? |
|----------|--------|-----|--------------|
| `apiKeyAuth(key)` | `@honua/sdk-js/auth` | Static API key → `X-API-Key`. | No |
| `bearerTokenAuth(token)` | `@honua/sdk-js/auth` | Static bearer → `Authorization: Bearer …`. | No |
| `oauth2(config)` | `@honua/sdk-js/auth` | OAuth2 authorization-code + PKCE (browser). | Yes |
| `clientCredentials(config)` | `@honua/sdk-js/auth` | OAuth2 client-credentials (Node/server). | No |

All four satisfy the core `HonuaAuthProvider` interface
(`getCredentials(context) → credentials`), so they drop straight into
`new HonuaClient({ auth })`. You can also pass a bare function
(`auth: (ctx) => ({ bearerToken })`) for fully custom logic.

## OAuth2 authorization-code + PKCE

`oauth2(config)` returns an `OAuth2Provider` that is **both** the client's auth
provider **and** the controller your app drives for the interactive flow.

### Flow (redirect mode — the default)

1. **Start sign-in.** `await auth.signIn()` generates a PKCE verifier
   (`code_verifier`), its S256 challenge, and an unguessable `state`, stashes the
   verifier + state in `sessionStorage`, and redirects the browser to the
   authorization endpoint. (The returned promise never resolves — the page
   unloads.)
2. **Handle the callback.** When the browser returns to `redirectUri`, call
   `await auth.handleRedirectCallback()`. It validates `state` (CSRF guard),
   exchanges the `code` + verifier at the token endpoint, and persists the
   tokens in the credential store.
3. **Use the client.** Every request now carries `Authorization: Bearer …`. When
   the access token nears expiry it is silently refreshed via the
   `refresh_token` grant.

```ts doc-test=skip reason="partial excerpt requires application host context"
// On the page that renders your app / callback:
if (auth.isRedirectCallback()) {
  await auth.handleRedirectCallback();      // completes the sign-in
} else if (!(await auth.isSignedIn())) {
  await auth.signIn();                       // starts the sign-in (redirects away)
}
```

### Popup mode

Set `mode: "popup"`. `await auth.signIn()` opens a popup, waits for the redirect
back to `redirectUri`, exchanges the code, and resolves with the stored
credential — no full-page navigation. The redirect page still runs your app; it
does not need to call `handleRedirectCallback()` because the opener reads the
result.

### Silent refresh & the no-refresh-token fallback

When a request needs a token and the cached one is expiring (within the
clock-skew window, default 60 s), the provider refreshes it using the
`refresh_token` grant. If the authorization server did **not** issue a refresh
token, the provider throws `HonuaAuthError` with code `interaction_required` —
your app should catch it and call `signIn()` again (or use a hidden-iframe /
silent-auth strategy of your own).

### Single-flight refresh

If _N_ concurrent requests all observe an expiring token, exactly **one**
token-endpoint round-trip is made; the other _N − 1_ await the same refresh.
This holds both inside the provider and at the client level.

### Lifecycle events

```ts doc-test=skip reason="partial excerpt requires application host context"
const handle = auth.on((event) => {
  switch (event.type) {
    case "signed-in":       /* event.credential */ break;
    case "token-refreshed": /* event.credential */ break;
    case "refresh-failed":  /* event.error (HonuaAuthError) */ break;
    case "signed-out":      break;
  }
});
handle.remove(); // unsubscribe
```

`await auth.signOut()` clears the stored credential (and calls the optional
`revocationEndpoint`), emitting `signed-out`.

## Client-credentials (Node / server)

For confidential server clients, use `clientCredentials`. There is no
interactive step; tokens are fetched on demand and re-requested when they expire
(this grant issues no refresh token). Refresh is single-flight.

```ts doc-test=compile
import { clientCredentials } from "@honua/sdk-js/auth";

const auth = clientCredentials({
  tokenEndpoint: "https://idp.example/token",
  clientId: process.env.CLIENT_ID!,
  clientSecret: process.env.CLIENT_SECRET!,
  scopes: ["honua.read"],
});
```

> **Never use `clientCredentials` in a browser** — the client secret would be
> exposed to every visitor. It is for Node/server processes only.

## Credential stores

Credentials are held in a pluggable `CredentialStore`, scoped per
origin/service (the key defaults to `${clientId}@${token-endpoint origin}`) so a
token for one service is never returned for another.

| Store | Import | Persistence | Risk |
|-------|--------|-------------|------|
| `InMemoryCredentialStore` (default) | `@honua/sdk-js/auth` | JS heap; cleared on reload | Lowest — no other script/tab can read it. |
| `sessionStorageCredentialStore()` | `@honua/sdk-js/auth` | Per-tab; cleared on tab close | Readable by any script on the origin (XSS). |
| `localStorageCredentialStore()` | `@honua/sdk-js/auth` | Across tabs & restarts | Highest — persists the exposure window. |

```ts doc-test=compile
import { oauth2, sessionStorageCredentialStore } from "@honua/sdk-js/auth";

const auth = oauth2({
  authorizationEndpoint: "https://identity.example.com/oauth2/authorize",
  tokenEndpoint: "https://identity.example.com/oauth2/token",
  clientId: "public-browser-client",
  redirectUri: "https://app.example.com/oauth/callback",
  store: sessionStorageCredentialStore(), // opt-in; understand the risk below
});
```

### Storage & security

- **Prefer the in-memory default.** Tokens never touch disk or Web Storage, so a
  script-injection (XSS) bug cannot exfiltrate a token from another context.
- **Web Storage is opt-in for a reason.** `sessionStorage`/`localStorage` are
  readable by _any_ JavaScript running on the origin. A single XSS vulnerability
  turns stored tokens into stolen tokens. `localStorage` is worse than
  `sessionStorage` because it persists across restarts and tabs.
- **Credentials are never sent cross-origin.** The client refuses to follow a
  cross-origin redirect (it never replays your `X-API-Key`/`Authorization` to a
  redirect target off the configured base origin — see
  [`errors.md`](./errors.md) and the credential-leak tests). Absolute request
  URLs to a different origin are rejected outright.
- **PKCE only, always S256.** The implicit flow is not supported; the code
  challenge method is always `S256`.

## Wiring into transports

The client resolves credentials through one shared pipeline, so providers apply
uniformly:

- **REST / fetch** — auth headers are merged onto every request; a replay-safe
  `401`/`403` triggers one force-refresh and a single retry.
- **gRPC-web** (`transport: "grpc-web"`) — a Connect interceptor re-resolves
  credentials on every call (and every retry attempt).
- **Realtime (SSE)** — native `EventSource` cannot set headers and reconnects
  internally, so realtime streams that need a token should carry it as a query
  parameter (or use a custom `eventSourceFactory`) and **re-read it on each
  (re)connect** so a refreshed token is picked up after a drop. Use
  `await client.getAuthToken()` / `await client.getAuthHeaders()` to obtain the
  current (refreshed) credential at connect time.

## Esri IdentityManager compatibility

Migrated ArcGIS apps that call `IdentityManager.registerOAuthInfos(...)` can be
backed by the real engine. Bind an `oauth2(...)` provider to a server and
`getCredential(url)` drives the actual PKCE / refresh flow:

```ts doc-test=compile
import { oauth2 } from "@honua/sdk-js/auth";
import { identityManager, OAuthInfoCompat } from "@honua/sdk-js/esri-compat";

const info = new OAuthInfoCompat({ appId: "app", portalUrl: "https://portal.example" });
identityManager.registerOAuthInfos([info]);
identityManager.registerOAuth2Engine(
  info.portalUrl,
  oauth2(info.toOAuth2Config({ redirectUri: `${location.origin}/callback` })),
);

// Drives the real flow (silent refresh, or interactive signIn on
// interaction_required), registers the token, and returns it:
const credential = await identityManager.getCredential("https://portal.example/sharing/rest");
```

`OAuthInfoCompat.toOAuth2Config()` derives the ArcGIS Portal endpoints
(`<portalUrl>/sharing/rest/oauth2/authorize` and `/token`) from `portalUrl` +
`appId`; pass explicit endpoints/overrides where needed.

## Errors

Auth failures are `HonuaAuthError` (in the typed error hierarchy) with a `.code`:

| `.code` | Meaning | Recover by |
|---------|---------|------------|
| `interaction_required` | No token and no way to get one silently. | `auth.signIn()`. |
| `refresh_failed` | Transient token-endpoint failure. | Retry later; the stored credential is kept. |
| `invalid_grant` | Refresh token / code expired or revoked. | The credential is cleared → `auth.signIn()`. |

See [`errors.md`](./errors.md) for the full hierarchy and the runnable example
under [`examples/oauth-signin/`](../examples/oauth-signin/).
