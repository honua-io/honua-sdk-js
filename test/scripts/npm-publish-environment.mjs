// The environment every real npm publish runs in; dry runs evaluate to '' and run without one.
export const NPM_PUBLISH_ENVIRONMENT =
  "${{ !(github.event_name == 'workflow_dispatch' && github.event.inputs.dry_run == 'true') && 'npm-publish' || '' }}";
