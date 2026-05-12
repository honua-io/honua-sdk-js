# Honua App Bootstrap Example

This example renders an inline `MapPackage` with `createHonuaApp()` from
`@honua/sdk-js/app`. It keeps MapLibre GL JS in the application code by
passing a `mapFactory`, so the app helper remains renderer-neutral.

Run it with:

```sh
npm run demo:app-bootstrap
```

Validation:

```sh
npm run demo:app-bootstrap:typecheck
npm run demo:app-bootstrap:build
npm run test:playwright:app-bootstrap
```
