#!/usr/bin/env node

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const args = {
    projectRoot: null,
    output: ".vercel/output",
    buildCommand: "npm run build",
    installCommand: "",
  };
  const readValue = (index, option) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${option}`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--output") {
      args.output = readValue(i, arg);
      i += 1;
    } else if (arg === "--project-root") {
      args.projectRoot = readValue(i, arg);
      i += 1;
    } else if (arg === "--build-command") {
      args.buildCommand = readValue(i, arg);
      i += 1;
    } else if (arg === "--install-command") {
      args.installCommand = readValue(i, arg);
      i += 1;
    } else if (arg === "--skip-build") {
      args.skipBuild = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (!args.projectRoot) {
      args.projectRoot = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return args;
}

function resolveProjectRoot(projectRootArg) {
  const invocationCwd = process.env.INIT_CWD || process.cwd();
  return path.resolve(invocationCwd, projectRootArg || ".");
}

function printHelp() {
  console.log(`Usage: vercel-next-local-build [project-root] [options]

Build a Next.js project with @vercel/next without invoking Vercel CLI project
network checks.

Project paths may be absolute or relative to the directory where this command
was invoked. When omitted, the current invocation directory is used.

Options:
  --project-root <dir>       Target project directory. Same as positional path
  --output <dir>             Output directory. Default: .vercel/output
  --build-command <command>  Command run by @vercel/next. Default: npm run build
  --install-command <cmd>    Install command. Default: empty string, skips install
  --skip-build               Package the existing .next output instead of building
  -h, --help                 Show this help
`);
}

function cleanObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  );
}

function installLineFilter(stream, shouldSuppress) {
  const originalWrite = stream.write.bind(stream);
  let buffer = "";
  let suppressed = 0;

  stream.write = (chunk, encoding, callback) => {
    const actualEncoding = typeof encoding === "string" ? encoding : undefined;
    const actualCallback = typeof encoding === "function" ? encoding : callback;
    const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    const lines = `${buffer}${text}`.split(/\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (shouldSuppress(line)) {
        suppressed += 1;
      } else {
        originalWrite(`${line}\n`, actualEncoding);
      }
    }

    if (typeof actualCallback === "function") {
      actualCallback();
    }
    return true;
  };

  return {
    restore() {
      stream.write = originalWrite;
      if (buffer) {
        if (shouldSuppress(buffer)) {
          suppressed += 1;
        } else {
          originalWrite(buffer);
        }
      }
      return suppressed;
    },
  };
}

async function withFilteredVercelRoutingWarnings(callback) {
  const shouldSuppress = (line) => line.startsWith("[vc] PATH TO REGEXP ");
  const stdout = installLineFilter(process.stdout, shouldSuppress);
  const stderr = installLineFilter(process.stderr, shouldSuppress);

  try {
    return await callback();
  } finally {
    const suppressed = stdout.restore() + stderr.restore();
    if (suppressed > 0) {
      console.log(
        `Suppressed ${suppressed} Vercel route parser compatibility warning${suppressed === 1 ? "" : "s"}.`
      );
    }
  }
}

function findVercelWriterChunk() {
  const vercelRoot = path.dirname(require.resolve("vercel/package.json"));
  const chunksDir = path.join(vercelRoot, "dist", "chunks");
  const chunkNames = fsSync.readdirSync(chunksDir);

  for (const chunkName of chunkNames) {
    if (!chunkName.endsWith(".js")) {
      continue;
    }

    const chunkPath = path.join(chunksDir, chunkName);
    const contents = fsSync.readFileSync(chunkPath, "utf8");
    if (
      contents.includes("async function writeBuildResult") &&
      contents.includes("writeBuildResultV2")
    ) {
      return chunkPath;
    }
  }

  throw new Error("Unable to locate Vercel's writeBuildResult implementation.");
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function isInsidePath(root, target) {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function assertInside(root, target) {
  if (!isInsidePath(root, target)) {
    throw new Error(`Refusing to write outside ${root}: ${target}`);
  }
}

function stripTopLevelNodeModules(relativePath) {
  const normalized = relativePath.split(path.sep).join(path.posix.sep);
  if (normalized === "node_modules") {
    return "";
  }
  if (normalized.startsWith("node_modules/")) {
    return normalized.slice("node_modules/".length);
  }
  return null;
}

async function copyFileOnce(sourcePath, targetPath, copyState) {
  const targetKey = path.resolve(targetPath);
  if (copyState.copiedTargets.has(targetKey)) {
    return false;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
  copyState.copiedTargets.add(targetKey);
  return true;
}

async function findFiles(root, fileName) {
  const results = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name === fileName) {
        results.push(entryPath);
      }
    }
  }

  await walk(root);
  return results;
}

async function copyExistingFile(sourcePath, targetPath, copyState, sourceLabel) {
  let sourceStat;
  try {
    sourceStat = await fs.stat(sourcePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`${sourceLabel} references a missing file: ${sourcePath}`);
    }
    throw error;
  }

  if (!sourceStat.isFile()) {
    return false;
  }

  return copyFileOnce(sourcePath, targetPath, copyState);
}

async function materializeNextServerNodeModulesTrace(projectRoot, outputDir, copyState) {
  const tracePath = path.join(projectRoot, ".next", "next-server.js.nft.json");
  const trace = await readJsonIfExists(tracePath);
  if (!trace?.files) {
    throw new Error(`No Next server trace found at ${tracePath}`);
  }

  const traceRoot = path.dirname(tracePath);
  const rootNodeModules = path.join(projectRoot, "node_modules");
  const outputNodeModules = path.join(outputDir, "node_modules");
  let copied = 0;

  for (const traceFile of trace.files) {
    const sourcePath = path.resolve(traceRoot, traceFile);
    if (!isInsidePath(rootNodeModules, sourcePath)) {
      continue;
    }

    const nodeModulesRelativePath = path.relative(rootNodeModules, sourcePath);
    const targetPath = path.join(outputNodeModules, nodeModulesRelativePath);
    assertInside(outputNodeModules, targetPath);

    if (await copyExistingFile(sourcePath, targetPath, copyState, "Next server trace")) {
      copied += 1;
    }
  }

  return copied;
}

async function materializeFunctionFilePathMaps(projectRoot, outputDir, copyState) {
  const functionsRoot = path.join(outputDir, "functions");
  const outputNodeModules = path.join(outputDir, "node_modules");
  const configPaths = await findFiles(functionsRoot, ".vc-config.json");
  let functionFiles = 0;
  let sharedNodeModuleFiles = 0;
  let removedFunctionNodeModules = 0;

  for (const configPath of configPaths) {
    const functionDir = path.dirname(configPath);
    const vcConfig = await readJsonIfExists(configPath);
    const filePathMap = vcConfig?.filePathMap || {};

    for (const [sourceRelativePath, targetRelativePath] of Object.entries(filePathMap)) {
      const sourcePath = path.resolve(projectRoot, sourceRelativePath);
      const nodeModulesTarget = stripTopLevelNodeModules(targetRelativePath);
      const targetPath =
        nodeModulesTarget === null
          ? path.resolve(functionDir, targetRelativePath)
          : path.resolve(outputNodeModules, nodeModulesTarget);
      assertInside(nodeModulesTarget === null ? functionDir : outputNodeModules, targetPath);

      if (await copyExistingFile(sourcePath, targetPath, copyState, "Function file map")) {
        if (nodeModulesTarget === null) {
          functionFiles += 1;
        } else {
          sharedNodeModuleFiles += 1;
        }
      }
    }

    const functionNodeModules = path.join(functionDir, "node_modules");
    if (fsSync.existsSync(functionNodeModules)) {
      await fs.rm(functionNodeModules, { recursive: true, force: true });
      removedFunctionNodeModules += 1;
    }
  }

  return {
    functionFiles,
    sharedNodeModuleFiles,
    removedFunctionNodeModules,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const projectRoot = resolveProjectRoot(args.projectRoot);
  const outputDir = path.resolve(projectRoot, args.output);
  const serverTemplatePath = path.join(packageRoot, "templates", "server.mjs");
  const effectiveBuildCommand = args.skipBuild ? "node -e \"\"" : args.buildCommand;
  const packageJsonPath = path.join(projectRoot, "package.json");
  const packageJson = await readJsonIfExists(packageJsonPath);

  if (!packageJson) {
    throw new Error(`No package.json found at ${packageJsonPath}`);
  }

  const nextVersion =
    packageJson.dependencies?.next || packageJson.devDependencies?.next;
  if (!nextVersion) {
    throw new Error("The target project does not declare a next dependency.");
  }

  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  const builder = require("@vercel/next");
  const builderPackage = require("@vercel/next/package.json");
  const writerChunk = await import(pathToFileURL(findVercelWriterChunk()).href);
  const { writeBuildResult } = writerChunk;

  if (typeof writeBuildResult !== "function") {
    throw new Error("Vercel writer chunk did not export writeBuildResult.");
  }

  const build = {
    src: "package.json",
    use: "@vercel/next",
    config: {
      zeroConfig: true,
      framework: "nextjs",
    },
  };
  const projectSettings = {
    framework: "nextjs",
    installCommand: args.installCommand,
    buildCommand: effectiveBuildCommand,
    outputDirectory: null,
    rootDirectory: null,
    nodeVersion: `${process.versions.node.split(".")[0]}.x`,
    createdAt: Date.now(),
  };
  const buildConfig = {
    ...build.config,
    installCommand: args.installCommand,
    buildCommand: effectiveBuildCommand || undefined,
    projectSettings,
  };

  console.log(`Building ${projectRoot}`);
  console.log(`Using next@${nextVersion} with @vercel/next@${builderPackage.version}`);
  if (!args.installCommand) {
    console.log("Install step: skipped");
  }
  if (args.skipBuild) {
    console.log("Build step: skipped");
  }

  const rawBuildResult = await withFilteredVercelRoutingWarnings(() =>
    builder.build({
      files: {},
      entrypoint: "package.json",
      workPath: projectRoot,
      repoRootPath: projectRoot,
      config: buildConfig,
      meta: {
        isDev: false,
      },
    })
  );

  const overrides = await writeBuildResult({
    repoRootPath: projectRoot,
    outputDir,
    buildResult: rawBuildResult,
    build,
    builder,
    builderPkg: builderPackage,
    vercelConfig: {},
    standalone: false,
    workPath: projectRoot,
  });

  const existingConfig = await readJsonIfExists(path.join(outputDir, "config.json"));
  const outputConfig = cleanObject({
    ...existingConfig,
    version: 3,
    routes: rawBuildResult.routes,
    images: rawBuildResult.images,
    wildcard: rawBuildResult.wildcard,
    overrides:
      overrides || rawBuildResult.overrides || existingConfig?.overrides,
    framework: rawBuildResult.framework || "nextjs",
    crons: rawBuildResult.crons,
  });

  await writeJson(path.join(outputDir, "config.json"), outputConfig);

  if (rawBuildResult.flags) {
    await writeJson(path.join(outputDir, "flags.json"), rawBuildResult.flags);
  }

  const copyState = {
    copiedTargets: new Set(),
  };
  const tracedNodeModuleFiles = await materializeNextServerNodeModulesTrace(
    projectRoot,
    outputDir,
    copyState
  );
  const materializedFiles = await materializeFunctionFilePathMaps(
    projectRoot,
    outputDir,
    copyState
  );

  await writeJson(path.join(outputDir, "builds.json"), {
    "//": "Generated by @private-poker/vercel-next-local-build. Not part of the Build Output API.",
    target: "local",
    builder: {
      name: "@vercel/next",
      version: builderPackage.version,
    },
    nextVersion,
    buildCommand: args.skipBuild ? null : args.buildCommand || null,
    installCommand: args.installCommand || null,
    sharedNodeModules: {
      trace: ".next/next-server.js.nft.json",
      tracedFiles: tracedNodeModuleFiles,
      functionFileMapFiles: materializedFiles.sharedNodeModuleFiles,
    },
  });

  await fs.copyFile(serverTemplatePath, path.join(outputDir, "server.mjs"));

  console.log(`Build output written to ${path.relative(projectRoot, outputDir)}`);
  console.log(
    `Materialized ${tracedNodeModuleFiles} traced files into ${path.relative(
      projectRoot,
      path.join(outputDir, "node_modules")
    )}`
  );
  console.log(
    `Materialized ${materializedFiles.functionFiles} function files and ${materializedFiles.sharedNodeModuleFiles} shared dependency files`
  );
  if (materializedFiles.removedFunctionNodeModules) {
    console.log(
      `Removed ${materializedFiles.removedFunctionNodeModules} function-local node_modules directories`
    );
  }
  console.log(`Run it with: node ${path.relative(projectRoot, path.join(outputDir, "server.mjs"))}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
