# create-honua-app

Scaffold a [Honua JavaScript SDK](https://github.com/honua-io/honua-sdk-js) map application — Vite + TypeScript,
pinned to a published SDK version, running a map on the first `npm run dev`.

```bash
npm create honua-app@latest my-map
cd my-map
npm install
npm run dev
```

## Options

```text
create-honua-app [directory] [options]

  -t, --template <id>   Starter to scaffold (default: vanilla-ts)
      --list-templates  Print the available templates and their playground links
      --force           Scaffold into a directory that already has files
  -h, --help            Print usage
  -v, --version         Print the create-honua-app version
```

With `npm create`, pass CLI options after `--`:

```bash
npm create honua-app@latest my-map -- --template react-ts
```

## Templates

| Template | What it shows |
| --- | --- |
| `vanilla-ts` | `connect → inspect → explain → query → mount`: the SDK owns the MapLibre map and mounts an accepted query plan. |
| `react-ts` | The app owns a plain `maplibre-gl` map; `useMountedSource` from `@honua/sdk-js/react` mounts the discovered source onto it. |

Both starters ship a committed GeoServices fixture served by the Vite dev and preview servers, so the green path
never depends on a third-party endpoint, an account, or an API key. Set `VITE_HONUA_ENDPOINT` to run the same code
against any anonymous, CORS-enabled GeoServices FeatureServer layer or OGC API Features landing page.

## Try a template without installing anything

Every template runs in a browser playground straight from the repository. The generated link list lives in
[`docs/playgrounds.md`](https://github.com/honua-io/honua-sdk-js/blob/trunk/docs/playgrounds.md), and
`create-honua-app --list-templates` prints the same links.

## License

Apache-2.0.
