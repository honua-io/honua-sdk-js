# Cloud-native exports from the CLI

Submit an export using an authenticated administrator connection:

```bash
honua export maui-parcels/1 --id maui-parcels
honua export list
honua export remove maui-parcels --yes
```

Submission returns the server's accepted job without waiting. To require public
publication and wait for its result:

```bash
honua export maui-parcels/1 --id maui-parcels --public --timeout-ms 600000
```

The server checks source eligibility, anonymous access, and the public copy.
`--public` uses the same export endpoint and credentials; it does not override
those checks or change the source's access policy. Success prints **Export
published**, the completed version and its confirmed `publicUrl`. `--json`
returns that completed export record. The CLI follows the submitted job and
refuses an unrelated job or an older publication.

If the export fails or the server cannot publish it publicly, the command exits
with an error and the server's reason. An export may remain available to signed-in
users after public publication is refused. The CLI does not remove that export.
A timeout also exits with an error; the submitted job can still finish. Inspect
`honua export list` before submitting another job. The default publication wait
is ten minutes, adjustable with a positive integer `--timeout-ms`.

Use `--dry-run --public` to preview the request and publication requirement
without creating a job. A preview does not prove public eligibility.
