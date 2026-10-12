## Executable docs — fail

Candidate `ghcr.io/honua-io/honua-server:nightly-93cad86@sha256:785de2ae7f72e6277ce62aa1ece4f08ee0425970b71c47f9f4843c0baae2c8db` · {'fail': 1, 'pass': 4}

| document | revision | status | pass | fail | needs-input | blocked | not-run |
|---|---|---|---|---|---|---|---|
| [honua-sdk-js:README.md](https://github.com/honua-io/honua-sdk-js/blob/a86b222878939a4c85abd1fe574303b60d81a3b5/README.md) | `a86b2228` | **pass** | 9 | 0 | 0 | 0 | 3 |
| [honua-sdk-js:INSTALL.md](https://github.com/honua-io/honua-sdk-js/blob/a86b222878939a4c85abd1fe574303b60d81a3b5/INSTALL.md) | `a86b2228` | **pass** | 3 | 0 | 0 | 0 | 0 |
| [honua-sdk-js:docs/quickstart.md](https://github.com/honua-io/honua-sdk-js/blob/a86b222878939a4c85abd1fe574303b60d81a3b5/docs/quickstart.md) | `a86b2228` | **pass** | 5 | 0 | 0 | 0 | 1 |
| [honua-sdk-js:mcp/README.md](https://github.com/honua-io/honua-sdk-js/blob/46ecd25a32ee2bfb7741ccc14ee5842c8824dd19/mcp/README.md) | `46ecd25a` | **fail** | 13 | 3 | 0 | 0 | 4 |
| [honua-sdk-js:packages/create-honua-app/README.md](https://github.com/honua-io/honua-sdk-js/blob/4ded33a5ee77cc3b289f85740f315d5f4a122fae/packages/create-honua-app/README.md) | `4ded33a5` | **pass** | 3 | 0 | 0 | 0 | 1 |

### Blocks requiring attention

- `honua-sdk-js:mcp/README.md` block 8 (line 278, typescript): **fail** — doc-test=compile; typechecked after the document's install steps: exit code 0; installed a Honua package the release does not pin: /home/runner/work/_temp/sdk-publication-replay/docs-work/honua-sdk-js-mcp-readme/app/honua-sdk-js/mcp/node_modules/@honua/sdk-js: @honua/sdk-js 0.1.15 (admitted version:
- `honua-sdk-js:mcp/README.md` block 14 (line 460, shell): **fail** — exit code 0; installed a Honua package the release does not pin: /home/runner/work/_temp/sdk-publication-replay/docs-work/honua-sdk-js-mcp-readme/app/honua-sdk-js/mcp/node_modules/@honua/sdk-js: @honua/sdk-js 0.1.15 (admitted version: 0.1.16)
- `honua-sdk-js:mcp/README.md` block 18 (line 597, shell): **fail** — exit code 0; installed a Honua package the release does not pin: /home/runner/work/_temp/sdk-publication-replay/docs-work/honua-sdk-js-mcp-readme/app/honua-sdk-js/mcp/node_modules/@honua/sdk-js: @honua/sdk-js 0.1.15 (admitted version: 0.1.16)
