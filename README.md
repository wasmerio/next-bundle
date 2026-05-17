# Local Vercel Next Builder

Builds the repo with `@vercel/next` without invoking `vercel build`, so it does
not perform Vercel CLI project lookup, auth, or environment pull checks.

From this package, pass the project path explicitly:

```sh
npm install
npm run build -- /path/to/next-project
```

From any directory, pass the project path after `--`. Relative paths are
resolved from the directory where you invoked npm, not from this wrapper
package:

```sh
npm --prefix packages/vercel-next-local-build install
npm --prefix packages/vercel-next-local-build run build -- .
npm --prefix packages/vercel-next-local-build run build -- ../another-project
npm --prefix packages/vercel-next-local-build run build -- /absolute/path/to/project
```

You can also use `--project-root` instead of the positional path:

```sh
npm --prefix packages/vercel-next-local-build run build -- --project-root /absolute/path/to/project
```

If the project path is omitted, the command builds the directory where npm was
invoked.

The output is written to:

```sh
.vercel/output
```

The build also writes a local Node.js server:

```sh
node .vercel/output/server.mjs
```

It also writes an optimized shared dependency tree next to the server:

```sh
.vercel/output/node_modules
```

That folder is materialized from `.next/next-server.js.nft.json`, plus any
extra dependency files referenced by Vercel's generated function file maps. The
function directories reuse this shared `node_modules` through Node's normal
module resolution instead of carrying duplicated dependency copies.

Set `PORT` to choose a port:

```sh
PORT=4000 node .vercel/output/server.mjs
```

By default the package:

- skips dependency installation in the target project
- runs `npm run build`
- uses the target project's declared `next` version
- calls `@vercel/next` directly and writes Build Output API files with Vercel's
  own output writer
- writes a local Node.js server that serves the generated Build Output API files

To package an existing `.next` directory without rebuilding:

```sh
npm --prefix packages/vercel-next-local-build run build -- . --skip-build
```
