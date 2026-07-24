# JavaScript migration tool transition

The JavaScript migration engine and npm package now live in
[`honua-io/honua-migrate`](https://github.com/honua-io/honua-migrate). Install
`@honua/honua-migrate` and use the JavaScript-specific executable:

```sh
npm install --save-dev @honua/honua-migrate
npx honua-js-migrate scan ./src
npx honua-js-migrate codemod ./src --write --report migration-report.json
```

Existing imports from `@honua/sdk-js/migration` remain valid and forward to
`@honua/honua-migrate`. The SDK's `scan:arcgis`, `scan:arcgis:widgets`, and
`migrate:arcgis` npm scripts also delegate to the new executable. Both
compatibility paths write a deprecation notice to stderr without changing
stdout, exit status, or migration artifacts.

The forwarders will remain for at least two consecutive `honua-migrate` minor
releases and 90 days. They will not be removed before `honua-migrate` 1.2.

The canonical Python executable remains `honua-migrate`; the JavaScript
executable is `honua-js-migrate`, avoiding a global command-name collision.
