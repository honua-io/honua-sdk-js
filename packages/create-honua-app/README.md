# create-honua-app

Scaffold a [Honua JavaScript SDK](https://github.com/honua-io/honua-sdk-js) map application — Vite + TypeScript,
running a map on the first `npm run dev`. These commands explicitly pin the SDK version documented here;
omit `--sdk-version` to follow the promoted release channel or this scaffold's certified fallback.

<!-- doc-run: run ready-url="http://localhost:5173/" -->
```bash
npm create honua-app@latest my-map -- --sdk-version 0.2.2 # x-release-please-version
cd my-map
npm install
npm run dev
```

Requires Node.js 22.12 or newer. Repository development uses the Node 22.23.3
LTS version pinned in `.nvmrc`.

## Options

```text
create-honua-app [directory] [options]

  -t, --template <id>   Starter to scaffold (default: vanilla-ts)
      --sdk-version <v> Pin this exact @honua/sdk-js version instead of the promoted
                        release channel (the only way to scaffold a prerelease)
      --list-templates  Print the available templates and their playground links
      --force           Scaffold into a directory that already has files
  -h, --help            Print usage
  -v, --version         Print the create-honua-app version
```

With `npm create`, pass CLI options after `--`:

```bash
npm create honua-app@latest my-react-map -- --template react-ts --sdk-version 0.2.2 # x-release-please-version
```

## Which SDK version a scaffold pins

The scaffold and SDK publish independently. `npm create honua-app@latest` selects the scaffold;
`--sdk-version` selects the SDK installed in the generated application. The explicit
SDK versions in this published README describe this scaffold release, even when a
newer SDK has shipped. Keep the flag when reproducing these examples, or select
another published SDK version deliberately.

The scaffold resolves `@honua/sdk-js` when it runs, from the `release-2026.1` npm dist-tag. Only a Honua release
promotion moves that tag, so a newly promoted SDK reaches fresh scaffolds without a new `create-honua-app`. The
generated `package.json` still records one exact version, so the app stays reproducible.

The channel is used only when it names a stable release on the starter's own SDK line. Until the channel is promoted,
or if it names a prerelease or another line, or if the registry cannot be read, the scaffold pins the certified
version this release of `create-honua-app` ships with. The default path never pins a prerelease. To choose a version
yourself, pass `--sdk-version`:

```bash
npm create honua-app@latest my-pinned-map -- --sdk-version 0.2.2 # x-release-please-version
```

## Templates

| Template | What it shows |
| --- | --- |
| `vanilla-ts` | `connect → inspect → explain → query → mount`: the SDK owns the MapLibre map and mounts an accepted query plan. |
| `react-ts` | The app owns a plain `maplibre-gl` map; the same kernel connection inspects, explains, queries, and mounts onto it. |

Both starters ship a committed GeoServices fixture served by the Vite dev and preview servers, so the green path
never depends on a third-party endpoint, an account, or an API key. Set `VITE_HONUA_ENDPOINT` to run the same code
against any anonymous, CORS-enabled GeoServices FeatureServer layer or OGC API Features landing page.

## Try a template without installing anything

Every template runs in a browser playground straight from the repository. The generated link list lives in
[`docs/playgrounds.md`](https://github.com/honua-io/honua-sdk-js/blob/trunk/docs/playgrounds.md), and
`create-honua-app --list-templates` prints the same links.

## License

Apache-2.0.
