# Share, Embed, and Open-Data Browser Contracts

`@honua/sdk-js/share` is a browser-safe projection of the canonical honua-server
Console Share contracts and the `honua-sdk-dotnet` console clients. The long-term
Console runtime is .NET/Blazor, but generated apps and embeddable map surfaces
need browser-safe types and helpers so they consume Share, embed-token,
public-link, and open-data state without inventing a second vocabulary.

This subpath owns **no transport**: it consumes server responses that are
already available. Admin/write share operations (mint links, enable embedding)
live on [`@honua/sdk-js/control-plane`](./split-packages.md).

```ts
import {
  denialFromHttpStatus,
  grantShareAccess,
  parseEmbedTokenFromFragment,
  toSchemaOrgDataset,
} from "@honua/sdk-js/share";
import type {
  HonuaEmbedRedemption,
  HonuaShareProjection,
} from "@honua/sdk-js/share";
```

## Contract vocabulary

The TypeScript names and string-literal values mirror the server JSON wire
contracts exactly, so a parsed `fetch` body assigns straight into the SDK type
with no remapping:

| SDK type | honua-server contract |
|----------|-----------------------|
| `HonuaShareAccessTier` (`private`/`organization`/`public-link`/`public-indexed`) | `ConsoleShareAccessTier` |
| `HonuaEmbedAudience` (`map`/`content`) | `ConsoleEmbedAudience` |
| `HonuaShareItemType` | `ConsoleContentItemType` |
| `HonuaPublicLinkToken` / `HonuaEmbedToken` | `ConsolePublicLinkToken` / `ConsoleEmbedToken` |
| `HonuaShareProjection` | `ConsoleShareProjection` |
| `HonuaPublicLinkResolution` | `ConsolePublicLinkResolutionResponse` |
| `HonuaEmbedRedemption` | `ConsoleEmbedRedeemResponse` |
| `HonuaShareDependencyConflict` | `ConsoleShareDependencyConflict` |

Each known string union stays open with `(string & {})` so a future server tier
or audience round-trips without a type error while keeping autocomplete on the
known members. `HONUA_SHARE_ACCESS_TIERS` and `HONUA_EMBED_AUDIENCES` export the
known members for validation/iteration.

## Fragment-only embed tokens

Embed bearer tokens MUST travel in the URL **fragment** (`#…`), never the query
string. The fragment is not sent to the origin, is not written to server access
logs or the `Referer` header, and is not captured by most proxy/CDN logging — so
a fragment-borne token has a much smaller disclosure surface.

`parseEmbedTokenFromFragment` enforces this. It **rejects** a query-string token
outright (even when a fragment token is also present) so a leak-prone placement
is never silently accepted:

```ts
parseEmbedTokenFromFragment("https://app/embed#embed_token=abc");
// → { ok: true, token: "abc", param: "embed_token" }

parseEmbedTokenFromFragment("https://app/embed?embed_token=abc");
// → { ok: false, reason: "query-string-token" }
```

Rejection reasons: `query-string-token`, `missing`, `empty`, `malformed`. In a
browser, pass `window.location.href`. `hasQueryStringEmbedToken(url)` is a guard
for asserting a redirect stripped a token before it reached a logged surface.

## Anonymous-safe denial states

The server's anonymous Share endpoints collapse unknown, expired, revoked,
forbidden, and no-longer-covered tokens into a single, identical denial that
never discloses item identity, title, or existence. `HonuaShareAccessState` is
the discriminated browser mirror:

```ts
async function resolvePublicLink(token: string): Promise<HonuaPublicLinkAccessState> {
  const res = await fetch(`/api/v1/console/share/link/${token}`);
  if (!res.ok) return denialFromHttpStatus("public-link", res.status);
  const body = (await res.json()) as { data: HonuaPublicLinkResolution };
  return grantShareAccess("public-link", body.data);
}
```

A denied state carries only a coarse `reason` (`not-found`/`expired`/`forbidden`)
and a constant, identity-free `message` sourced from
`HONUA_SHARE_DENIAL_MESSAGES` — never from caller-supplied item data — so private
titles cannot leak through this path. The message content is identical across
reasons for a given kind, so it is not an existence oracle.

## Open-data read projections

For an open-data landing card, `HonuaOpenDataReadProjection` is the
anonymous-safe read model. `toDcatDataset` and `toSchemaOrgDataset` project a
held read model into standards-aligned metadata (W3C DCAT / DCAT-AP and a
Schema.org `Dataset` JSON-LD node) for injection into an open-data page:

```ts
const ld = toSchemaOrgDataset(projection);
// <script type="application/ld+json">{ "@context": "https://schema.org", ... }</script>
```

Both helpers omit unset/empty fields. When honua-server's open-data publication
API ships its own DCAT/STAC projection, prefer the server-emitted document; these
helpers remain the browser fallback for responses that only carry the read model.

## Status

Experimental — not yet covered by the SDK's semver contract; the surface may
change in any minor release prior to `1.0.0`.
