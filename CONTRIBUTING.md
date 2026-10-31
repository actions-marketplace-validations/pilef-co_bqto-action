# Contributing

The action has no dependencies, so it has no build step and no `dist/`.

## Tests

`node test.mjs` runs the action against a fake bqto and a fake gcloud. The tests
need Linux. On macOS, run them in a container:

```sh
docker run --rm -v "$PWD":/a -w /a node:24-slim node test.mjs
```

## Updating bqto

To vendor the binaries of another bqto release, run the script with its tag:

```sh
bin/update.sh v0.16.0
```

The script downloads the Linux archives and `checksums.txt` of the release and
checks each archive against `checksums.txt`. Without a tag, it downloads the
release that `bin/checksums.txt` names. CI runs it without a tag and fails if
`bin/` changes.

The `update-bqto` workflow runs the script and opens a pull request. Run it from
the Actions tab.
