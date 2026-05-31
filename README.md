# next-bundle

Builds a Next.js project with `@vercel/next` without invoking `vercel build`, so
it does not perform Vercel CLI project lookup, auth, or environment pull checks.

Once published or otherwise available to npm, run it with `npx`:

```sh
npx next-bundle /path/to/next-project
```

From this package checkout, pass the project path explicitly:

```sh
npm install
npm run build -- /path/to/next-project
```

From any directory, pass the project path after `--`. Relative paths are
resolved from the directory where you invoked npm, not from this package:

```sh
npm --prefix packages/next-bundle install
npm --prefix packages/next-bundle run build -- .
npm --prefix packages/next-bundle run build -- ../another-project
npm --prefix packages/next-bundle run build -- /absolute/path/to/project
```

You can also use `--project-root` instead of the positional path:

```sh
npx next-bundle --project-root /absolute/path/to/project
npm --prefix packages/next-bundle run build -- --project-root /absolute/path/to/project
```

If the project path is omitted, the command builds the directory where npm was
invoked.

The output is written to:

```sh
.next-bundle
```

The build also writes a local Node.js server:

```sh
node .next-bundle/server.mjs
```

It also writes an optimized shared dependency tree next to the server:

```sh
.next-bundle/node_modules
```

That folder is materialized from `.next/next-server.js.nft.json`, plus any
extra dependency files referenced by Vercel's generated function file maps and
the local runtime packages needed by `next-bundle`. The function directories
reuse this shared `node_modules` through Node's normal module resolution instead
of carrying duplicated dependency copies.

`next-bundle` also preserves node_modules symlinks whose targets were
materialized into the output. For example, if traced files are copied under
`node_modules/.pnpm/next@.../node_modules/next`, the output includes the matching
`node_modules/next` symlink when the source install has one.

Set `PORT` to choose a port:

```sh
PORT=4000 node .next-bundle/server.mjs
```

By default the package:

- skips dependency installation in the target project
- runs `npm run build`
- uses the target project's declared `next` version
- calls `@vercel/next` directly and writes Build Output API files with Vercel's
  own output writer
- writes a local Node.js server that serves the generated Build Output API files
- handles `/_next/image` locally, including Photon-backed raster resizing when
  WebAssembly is available

To package an existing `.next` directory without rebuilding:

```sh
npx next-bundle . --skip-build
npm --prefix packages/next-bundle run build -- . --skip-build
```
