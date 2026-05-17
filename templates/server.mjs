#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const serverPath = fileURLToPath(import.meta.url);
const outputRoot = path.resolve(path.dirname(serverPath));
const staticRoot = path.join(outputRoot, "static");
const functionsRoot = path.join(outputRoot, "functions");
const config = JSON.parse(
  fs.readFileSync(path.join(outputRoot, "config.json"), "utf8")
);
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const functionCache = new Map();
const middlewareCache = new Map();
let functionRouteMap;

const contentTypes = {
  ".avif": "image/avif",
  ".body": "application/octet-stream",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".rsc": "text/x-component; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
};

function normalizeRequestPath(value) {
  let pathname = value || "/";
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Keep the raw path if it is not valid percent-encoded input.
  }
  pathname = path.posix.normalize(`/${pathname}`).replace(/\/+$/, "") || "/";
  return pathname;
}

function safeJoin(root, requestPath) {
  const normalized = path.posix.normalize(`/${requestPath}`).replace(/^\/+/, "");
  const joined = path.join(root, normalized);
  const relative = path.relative(root, joined);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return joined;
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function dirExists(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function readJsonSyncIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function setHeaders(res, headers = {}) {
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      res.setHeader(key, String(value));
    }
  }
}

async function sendFile(req, res, filePath, statusCode = 200, headers = {}) {
  if (!filePath || !fileExists(filePath)) {
    return false;
  }

  const stat = await fsp.stat(filePath);
  const ext = path.extname(filePath);
  res.statusCode = statusCode;
  setHeaders(res, {
    "content-type": contentTypes[ext] || "application/octet-stream",
    "content-length": stat.size,
    ...headers,
  });

  if (req.method === "HEAD") {
    res.end();
  } else {
    fs.createReadStream(filePath).pipe(res);
  }
  return true;
}

function outputKey(pathname) {
  if (pathname === "/") {
    return "index";
  }
  return pathname.replace(/^\/+/, "");
}

function outputCandidates(pathname) {
  const key = outputKey(pathname);
  const candidates = [key];
  if (!path.extname(key)) {
    candidates.push(`${key}.html`);
  }
  return [...new Set(candidates)];
}

function findStatic(pathname) {
  for (const candidate of outputCandidates(pathname)) {
    const filePath = safeJoin(staticRoot, candidate);
    if (fileExists(filePath)) {
      return filePath;
    }
  }
  return null;
}

function findFunction(pathname) {
  for (const candidate of outputCandidates(pathname)) {
    const dirPath = safeJoin(functionsRoot, `${candidate}.func`);
    if (dirExists(dirPath)) {
      return dirPath;
    }
  }

  return getFunctionRouteMap().get(functionPagePath(pathname)) || null;
}

function collectFunctionDirs(root) {
  const dirs = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const entryPath = path.join(dir, entry.name);
      if (entry.name.endsWith(".func")) {
        dirs.push(entryPath);
      } else {
        walk(entryPath);
      }
    }
  }

  walk(root);
  return dirs;
}

function appManifestRouteToPath(route) {
  const segments = route
    .split("/")
    .filter(Boolean)
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
    .filter((segment) => !segment.startsWith("@"));

  const last = segments[segments.length - 1];
  if (last === "page" || last === "route") {
    segments.pop();
  }

  const routePath = `/${segments.join("/")}`;
  return routePath === "/index" ? "/" : normalizeRequestPath(routePath);
}

function functionPagePath(pathname) {
  let pagePath = pathname
    .replace(/\.segments\/.*\.segment\.rsc$/, "")
    .replace(/\.prefetch\.rsc$/, "")
    .replace(/\.rsc$/, "")
    .replace(/\.action$/, "");

  pagePath = normalizeRequestPath(pagePath);
  return pagePath === "/index" ? "/" : pagePath;
}

function getFunctionRouteMap() {
  if (functionRouteMap) {
    return functionRouteMap;
  }

  functionRouteMap = new Map();
  for (const functionDir of collectFunctionDirs(functionsRoot)) {
    const vcConfig = readJsonSyncIfExists(path.join(functionDir, ".vc-config.json"));
    if (vcConfig?.operationType !== "Page") {
      continue;
    }

    const appPaths = readJsonSyncIfExists(
      path.join(functionDir, ".next", "server", "app-paths-manifest.json")
    );
    for (const route of Object.keys(appPaths || {})) {
      const routePath = appManifestRouteToPath(route);
      if (!functionRouteMap.has(routePath)) {
        functionRouteMap.set(routePath, functionDir);
      }
    }
  }

  return functionRouteMap;
}

function findPrerender(pathname) {
  for (const candidate of outputCandidates(pathname)) {
    const configPath = safeJoin(functionsRoot, `${candidate}.prerender-config.json`);
    if (fileExists(configPath)) {
      return configPath;
    }
  }
  return null;
}

function hasOutput(pathname) {
  return Boolean(findStatic(pathname) || findFunction(pathname) || findPrerender(pathname));
}

function compileRoute(source) {
  return new RegExp(source);
}

function requestHeader(req, key) {
  return req.headers[key.toLowerCase()];
}

function conditionMatches(req, condition, params) {
  if (condition.type !== "header") {
    return false;
  }

  const value = requestHeader(req, condition.key);
  if (value === undefined) {
    return false;
  }

  if (!condition.value) {
    return true;
  }

  const match = new RegExp(condition.value).exec(Array.isArray(value) ? value[0] : value);
  if (!match) {
    return false;
  }

  Object.assign(params, match.groups || {});
  return true;
}

function routeMatches(req, route, pathname, params) {
  if (!route.src) {
    return false;
  }

  if (route.has) {
    for (const condition of route.has) {
      if (!conditionMatches(req, condition, params)) {
        return false;
      }
    }
  }

  if (route.missing) {
    for (const condition of route.missing) {
      if (condition.type === "header" && requestHeader(req, condition.key) !== undefined) {
        return false;
      }
    }
  }

  const match = compileRoute(route.src).exec(pathname);
  if (!match) {
    return false;
  }
  if (route.src.startsWith("^") && (match.index !== 0 || match[0] !== pathname)) {
    return false;
  }

  Object.assign(params, match.groups || {});
  for (let index = 1; index < match.length; index += 1) {
    params[index] = match[index] || "";
  }
  return true;
}

function interpolate(value, params) {
  if (!value) {
    return value;
  }
  return value.replace(/\$(\w+)/g, (_full, key) => params[key] || "");
}

function splitDest(dest) {
  const parsed = new URL(dest, "http://local.invalid");
  return {
    pathname: normalizeRequestPath(parsed.pathname),
    search: parsed.search,
  };
}

function splitAbsoluteDest(dest) {
  const parsed = new URL(dest, "http://local.invalid");
  return {
    pathname: normalizeRequestPath(parsed.pathname),
    search: parsed.search,
  };
}

function toWebHeaders(headers) {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers || {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        result.append(key, String(item));
      }
    } else if (value !== undefined) {
      result.set(key, String(value));
    }
  }
  return result;
}

function getMiddlewareFunction(route) {
  const middlewarePath = route.middlewarePath;
  if (!middlewarePath) {
    return null;
  }

  let middleware = middlewareCache.get(middlewarePath);
  if (middleware) {
    return middleware;
  }

  const functionDir = safeJoin(functionsRoot, `${middlewarePath}.func`);
  if (!functionDir || !dirExists(functionDir)) {
    return null;
  }

  const vcConfig = readJsonSyncIfExists(path.join(functionDir, ".vc-config.json"));
  if (vcConfig?.runtime !== "edge") {
    return null;
  }

  middleware = {
    functionDir,
    entrypoint: vcConfig.entrypoint || "index.js",
    modulePromise: null,
  };
  middlewareCache.set(middlewarePath, middleware);
  return middleware;
}

async function loadMiddleware(middleware) {
  if (!middleware.modulePromise) {
    globalThis.self ||= globalThis;
    globalThis.require ||= require;
    globalThis.AsyncLocalStorage ||= AsyncLocalStorage;

    const entrypointPath = path.join(middleware.functionDir, middleware.entrypoint);
    const source = fs.readFileSync(entrypointPath, "utf8");
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
    middleware.modulePromise = import(moduleUrl).then((mod) => {
      if (typeof mod.default !== "function") {
        throw new Error(`Middleware ${entrypointPath} did not export a default function.`);
      }
      return mod.default;
    });
  }

  return middleware.modulePromise;
}

function applyMiddlewareRequestOverrides(req, responseHeaders) {
  const overrideHeader = responseHeaders.get("x-middleware-override-headers");
  if (!overrideHeader) {
    return;
  }

  for (const key of overrideHeader.split(",").map((item) => item.trim()).filter(Boolean)) {
    const value = responseHeaders.get(`x-middleware-request-${key}`);
    if (value !== null) {
      req.headers[key.toLowerCase()] = value;
    }
  }
}

function appendResponseHeaders(target, responseHeaders) {
  for (const [key, value] of responseHeaders.entries()) {
    if (!key.startsWith("x-middleware-")) {
      target[key] = value;
    }
  }
}

async function runMiddleware(route, req, res, accumulatedHeaders) {
  const middleware = getMiddlewareFunction(route);
  if (!middleware) {
    return null;
  }

  const handler = await loadMiddleware(middleware);
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const response = await handler(
    {
      url: requestUrl.href,
      method: req.method || "GET",
      headers: toWebHeaders(req.headers),
      body: null,
    },
    {
      waitUntil() {},
    }
  );

  if (!response) {
    return null;
  }

  const responseHeaders = response.headers || new Headers();
  applyMiddlewareRequestOverrides(req, responseHeaders);
  appendResponseHeaders(accumulatedHeaders, responseHeaders);

  const redirect = responseHeaders.get("location") || responseHeaders.get("x-middleware-redirect");
  if (redirect) {
    res.writeHead(response.status || 307, {
      ...accumulatedHeaders,
      Location: redirect,
    });
    res.end();
    return { handled: true };
  }

  const rewrite = responseHeaders.get("x-middleware-rewrite");
  if (rewrite) {
    const next = splitAbsoluteDest(rewrite);
    return {
      pathname: next.pathname,
      search: next.search,
    };
  }

  const nextHeader = responseHeaders.get("x-middleware-next");
  if (!nextHeader && response.status && response.status !== 200) {
    res.writeHead(response.status, accumulatedHeaders);
    if (req.method === "HEAD") {
      res.end();
    } else {
      const body = await response.text();
      res.end(body);
    }
    return { handled: true };
  }

  return null;
}

async function servePrerender(req, res, configPath, statusCode = 200, headers = {}) {
  const prerender = JSON.parse(await fsp.readFile(configPath, "utf8"));
  const fallback = prerender.fallback;
  if (!fallback || !fallback.fsPath) {
    return false;
  }

  const filePath = safeJoin(functionsRoot, fallback.fsPath);
  return sendFile(req, res, filePath, statusCode, {
    ...prerender.initialHeaders,
    ...headers,
    ...(fallback.contentType ? { "content-type": fallback.contentType } : {}),
  });
}

function getFunctionHandler(functionDir) {
  let handler = functionCache.get(functionDir);
  if (handler) {
    return handler;
  }

  const configPath = path.join(functionDir, ".vc-config.json");
  const vcConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const handlerPath = path.join(functionDir, vcConfig.handler || "index.js");
  const previousCwd = process.cwd();
  process.chdir(functionDir);
  try {
    handler = require(handlerPath);
  } finally {
    process.chdir(previousCwd);
  }
  functionCache.set(functionDir, handler);
  return handler;
}

async function serveFunction(req, res, functionDir, pathname, search) {
  const handler = getFunctionHandler(functionDir);
  const originalUrl = req.url;
  const originalMatchedPath = req.headers["x-matched-path"];
  const previousCwd = process.cwd();
  req.url = `${pathname}${search || ""}`;
  req.headers["x-matched-path"] ||= pathname;
  process.chdir(functionDir);
  try {
    await handler(req, res);
  } finally {
    req.url = originalUrl;
    if (originalMatchedPath === undefined) {
      delete req.headers["x-matched-path"];
    } else {
      req.headers["x-matched-path"] = originalMatchedPath;
    }
    process.chdir(previousCwd);
  }
  return true;
}

async function serveOutput(req, res, pathname, search, statusCode = 200, headers = {}) {
  const staticPath = findStatic(pathname);
  if (staticPath) {
    return sendFile(req, res, staticPath, statusCode, headers);
  }

  const prerenderPath = findPrerender(pathname);
  if (prerenderPath) {
    if (await servePrerender(req, res, prerenderPath, statusCode, headers)) {
      return true;
    }
  }

  const functionDir = findFunction(pathname);
  if (functionDir) {
    setHeaders(res, headers);
    if (statusCode !== 200) {
      res.statusCode = statusCode;
    }
    return serveFunction(req, res, functionDir, pathname, search);
  }

  return false;
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  let pathname = normalizeRequestPath(url.pathname);
  let search = url.search;
  let statusCode = 200;
  const accumulatedHeaders = {};

  for (const route of config.routes || []) {
    if (route.handle === "filesystem") {
      if (await serveOutput(req, res, pathname, search, statusCode, accumulatedHeaders)) {
        return;
      }
      continue;
    }

    if (route.handle) {
      continue;
    }

    const params = {};
    if (!routeMatches(req, route, pathname, params)) {
      continue;
    }

    const routeHeaders = {};
    for (const [key, value] of Object.entries(route.headers || {})) {
      routeHeaders[key] = interpolate(String(value), params);
    }
    Object.assign(accumulatedHeaders, routeHeaders);

    if (route.middlewarePath) {
      const middlewareResult = await runMiddleware(route, req, res, accumulatedHeaders);
      if (middlewareResult?.handled) {
        return;
      }
      if (middlewareResult?.pathname) {
        pathname = middlewareResult.pathname;
        search = middlewareResult.search || search;
      }
    }

    if (route.status && route.status >= 300 && route.status < 400 && routeHeaders.Location) {
      res.writeHead(route.status, routeHeaders);
      res.end();
      return;
    }

    if (route.dest) {
      const dest = interpolate(route.dest, params);
      if (/^https?:\/\//.test(dest)) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(`External rewrite is not supported by this local server: ${dest}\n`);
        return;
      }

      const next = splitDest(dest);
      if (route.check && !hasOutput(next.pathname)) {
        continue;
      }
      pathname = next.pathname;
      search = next.search || search;
    }

    if (route.status && !route.dest && !route.continue) {
      continue;
    }

    if (route.status) {
      statusCode = route.status;
    }

    if (route.status && !route.continue) {
      if (await serveOutput(req, res, pathname, search, statusCode, accumulatedHeaders)) {
        return;
      }
      res.writeHead(route.status, accumulatedHeaders);
      res.end(http.STATUS_CODES[route.status] || String(route.status));
      return;
    }

    if (!route.continue && route.dest) {
      break;
    }
  }

  if (await serveOutput(req, res, pathname, search, statusCode, accumulatedHeaders)) {
    return;
  }

  if (await serveOutput(req, res, "/404", "", 404, accumulatedHeaders)) {
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not Found\n");
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end("Internal Server Error\n");
  });
});

server.listen(port, host, () => {
  console.log(`Serving ${outputRoot}`);
  console.log(`Listening on http://${host}:${port}`);
});
