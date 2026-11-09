// Agent file check for pull requests. Node built-ins only (global fetch, fs, path,
// child_process). Lists the files the pull request changes through the GitHub
// REST API (works on shallow checkouts, needs no git history), or on a later push
// only the files that push changed, reads the agent files from the checkout, sends
// them to FixMyPrompt and posts or updates one marked comment. Only a score below
// fail-below fails the check; FixMyPrompt being unreachable, down or out of free
// checks never does.
//
// It also sends the root package.json and the workspace package.json files, so
// the check can name commands that are not scripts, and (unless send-file-list is
// false) the names of the files git tracks, not their contents, so it can name
// paths that do not exist. Nothing is stored.
import { readFileSync, lstatSync, realpathSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER = "<!-- fmp-doctor -->";

const PATTERNS = [
  /^(?:.*\/)?CLAUDE\.md$/,
  /^(?:.*\/)?AGENTS\.md$/,
  /^\.cursorrules$/,
  /^\.cursor\/rules\/.+/,
  /^\.github\/copilot-instructions\.md$/,
  /^GEMINI\.md$/,
];

/** The paths that are agent instruction files. */
export function agentFiles(paths) {
  return paths.filter((p) => PATTERNS.some((re) => re.test(p)));
}

const log = (m) => console.log(m);

async function gh(path, init = {}) {
  const res = await fetch(`${process.env.GITHUB_API_URL || "https://api.github.com"}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${init.method || "GET"} ${path} answered ${res.status}`);
  return res.status === 204 ? null : res.json();
}

async function changedPaths(repo, pr) {
  const paths = [];
  for (let page = 1; page <= 30; page++) {
    const rows = await gh(`/repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`);
    for (const r of rows) if (r.status !== "removed") paths.push(r.filename);
    if (rows.length < 100) break;
  }
  return paths;
}

const NO_SHA = /^0*$/;

/**
 * On a push to an open pull request (synchronize), the files that push changed:
 * the compare between the event's before and after commits. null when there is
 * no usable before (missing or all zeros) or the compare cannot answer (a force
 * push can drop the old commit), so the caller falls back to the whole pull request.
 */
async function pushPaths(repo, ev) {
  if (ev?.action !== "synchronize") return null;
  const before = typeof ev.before === "string" ? ev.before : "";
  const after = typeof ev.after === "string" ? ev.after : "";
  if (!before || NO_SHA.test(before) || !after || NO_SHA.test(after)) return null;
  const paths = [];
  try {
    for (let page = 1; page <= 30; page++) {
      const res = await gh(`/repos/${repo}/compare/${before}...${after}?per_page=100&page=${page}`);
      for (const f of res?.files ?? []) if (f.status !== "removed") paths.push(f.filename);
      if (!Array.isArray(res?.commits) || res.commits.length < 100) break;
    }
  } catch (e) {
    log(`Could not list this push's files (${e?.message ?? "unknown"}). Checking the whole pull request.`);
    return null;
  }
  return [...new Set(paths)];
}

async function findComment(repo, pr) {
  for (let page = 1; page <= 20; page++) {
    const rows = await gh(`/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    const found = rows.find(
      (c) => typeof c.body === "string" && c.body.startsWith(MARKER) && c.user?.type === "Bot" && c.user?.login === "github-actions[bot]",
    );
    if (found) return found;
    if (rows.length < 100) break;
  }
  return null;
}

async function upsertComment(repo, pr, body, existing) {
  if (existing === undefined) existing = await findComment(repo, pr);
  const payload = JSON.stringify({ body });
  const headers = { "Content-Type": "application/json" };
  if (existing) await gh(`/repos/${repo}/issues/comments/${existing.id}`, { method: "PATCH", body: payload, headers });
  else await gh(`/repos/${repo}/issues/${pr}/comments`, { method: "POST", body: payload, headers });
}

/** Marked comment for an error answer: the plain note, nothing else from the response. */
export function noteComment(note) {
  return `${MARKER}\n${String(note || "FixMyPrompt could not check these files.").slice(0, 2000)}`;
}

function readEvent() {
  try {
    return JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  } catch {
    return null;
  }
}

/** True for a regular file (not a symlink) whose real path is inside the workspace. */
export function safeToRead(p, root = process.cwd()) {
  try {
    if (!lstatSync(p).isFile()) return false;
    const base = realpathSync(root);
    const real = realpathSync(p);
    return real === base || real.startsWith(base + sep);
  } catch {
    return false;
  }
}

/** The limits FixMyPrompt accepts. Over one, that part is not sent at all, never cut short. */
export const REPO_LIMITS = { paths: 20_000, pathBytes: 1_000_000, pathLength: 1_024, packages: 50, packageChars: 100_000, packagesTotalChars: 500_000 };

/**
 * The `packages:` list of a pnpm-workspace.yaml, read line by line: a block
 * list (- 'apps/*') or a one-line flow list (['apps/*']). incomplete is true
 * when there is a packages key this cannot read.
 */
export function pnpmWorkspace(text) {
  const globs = [];
  let incomplete = false;
  let inList = false;
  const item = (v) => v.trim().replace(/^["']|["']$/g, "");
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    const key = /^packages\s*:\s*(.*)$/.exec(line);
    if (key) {
      const rest = key[1].trim();
      if (rest === "") inList = true;
      else if (/^\[[^\]]*\]$/.test(rest)) globs.push(...rest.slice(1, -1).split(",").map(item).filter(Boolean));
      else incomplete = true;
      continue;
    }
    if (!inList || line.trim() === "") continue;
    const m = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (m && !/^[[{]/.test(m[1])) globs.push(item(m[1]));
    else if (!/^\s/.test(line)) inList = false;
    else incomplete = true;
  }
  return { globs, incomplete };
}

/** The `packages:` globs of a pnpm-workspace.yaml (see pnpmWorkspace). */
export const pnpmWorkspaceGlobs = (text) => pnpmWorkspace(text).globs;

/** package.json "workspaces": an array, or {packages: [...]} (yarn). */
export function packageWorkspaceGlobs(pkgText) {
  try {
    const w = JSON.parse(pkgText)?.workspaces;
    const list = Array.isArray(w) ? w : Array.isArray(w?.packages) ? w.packages : [];
    return list.filter((g) => typeof g === "string");
  } catch {
    return [];
  }
}

/**
 * The folders a workspace glob names. Simple patterns only: a plain folder
 * ("packages/core") or one star as the last part ("apps/*"). Anything else
 * (**, !, braces, ..) is skipped. Never follows a symlink.
 */
/** "skip" for a negation (it only removes folders), "unsupported" for a pattern expandWorkspaceGlob cannot read. */
export function globKind(glob) {
  const g = String(glob).trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (g.startsWith("!")) return "skip";
  if (!g || g.startsWith("/") || /[?{}[\]]|\*\*/.test(g) || g.split("/").includes("..")) return "unsupported";
  const star = g.indexOf("*");
  if (star !== -1 && (!g.endsWith("/*") || star !== g.length - 1)) return "unsupported";
  return "ok";
}

export function expandWorkspaceGlob(glob, root = process.cwd()) {
  const g = String(glob).trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (!g || g.startsWith("/") || g.startsWith("!") || /[?{}[\]]|\*\*/.test(g) || g.split("/").includes("..")) return [];
  const star = g.indexOf("*");
  if (star === -1) return [g];
  if (!g.endsWith("/*") || g.indexOf("*") !== g.length - 1) return [];
  const parent = g.slice(0, -2);
  try {
    const base = `${root}${sep}${parent.split("/").join(sep)}`;
    if (parent && !lstatSync(base).isDirectory()) return [];
    return readdirSync(parent ? base : root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
      .map((d) => (parent ? `${parent}/${d.name}` : d.name))
      .sort();
  } catch {
    return [];
  }
}

/** A file's text when it is a regular file inside the workspace (safeToRead), else null. */
function readSafe(p, root) {
  const abs = `${root}${sep}${p.split("/").join(sep)}`;
  try {
    return safeToRead(abs, root) ? readFileSync(abs, "utf8") : null;
  } catch {
    return null;
  }
}

/**
 * The root package.json and the workspace package.json files it and
 * pnpm-workspace.yaml name, as {path, text}, and whether a workspace pattern
 * was skipped (incomplete). Over REPO_LIMITS: no packages at all, since a
 * partial set could make a missing script look missing everywhere.
 */
export function collectPackages(root = process.cwd()) {
  const rootText = readSafe("package.json", root);
  if (rootText === null) return { packages: [], incomplete: false };
  const globs = [...packageWorkspaceGlobs(rootText)];
  let incomplete = false;
  const pnpm = readSafe("pnpm-workspace.yaml", root);
  if (pnpm !== null) {
    const w = pnpmWorkspace(pnpm);
    globs.push(...w.globs);
    incomplete ||= w.incomplete;
  }
  const out = [{ path: "package.json", text: rootText }];
  const seen = new Set([""]);
  for (const glob of globs) {
    const kind = globKind(glob);
    if (kind === "unsupported") incomplete = true;
    if (kind !== "ok") continue;
    for (const dir of expandWorkspaceGlob(glob, root)) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      const text = readSafe(`${dir}/package.json`, root);
      if (text !== null) out.push({ path: `${dir}/package.json`, text });
    }
  }
  const total = out.reduce((n, p) => n + p.text.length, 0);
  if (out.length > REPO_LIMITS.packages || total > REPO_LIMITS.packagesTotalChars || out.some((p) => p.text.length > REPO_LIMITS.packageChars)) {
    log("Too many or too large package.json files to send. The commands check is skipped.");
    return { packages: [], incomplete };
  }
  if (incomplete) log("Some workspace patterns could not be read, so commands outside a named workspace are not checked.");
  return { packages: out, incomplete };
}

/** Every name git tracks (git ls-files), or null when git cannot list them. */
export function trackedFiles(root = process.cwd()) {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\0").filter(Boolean);
  } catch {
    log("Could not list the repository's files with git. The paths check is skipped.");
    return null;
  }
}

/** The names to send, or null when there are too many. A name FixMyPrompt would refuse is left out, not the whole list. */
export function collectPaths(root = process.cwd(), tracked = trackedFiles(root)) {
  if (!tracked) return null;
  const paths = tracked.filter((p) => p.length <= REPO_LIMITS.pathLength && !/[\r\n]/.test(p));
  const bytes = paths.reduce((n, p) => n + Buffer.byteLength(p, "utf8"), 0);
  if (paths.length > REPO_LIMITS.paths || bytes > REPO_LIMITS.pathBytes) {
    log(`This repository has too many files to send their names (${paths.length}). The paths check is skipped.`);
    return null;
  }
  return paths;
}

/** True when git tracks a package.json (outside node_modules) that is not among the ones sent. */
export function hasMorePackages(tracked, packages) {
  if (!tracked) return false;
  const sent = new Set(packages.map((p) => p.path));
  return tracked.some((p) => /(^|\/)package\.json$/.test(p) && !p.split("/").includes("node_modules") && !sent.has(p));
}

/** The file list is sent unless send-file-list is false, no, 0 or off (any case). */
export const sendsFileList = (v) => !/^(false|no|0|off)$/i.test(String(v ?? "true").trim());

/** repoFiles for the request, or undefined when there is nothing to send. */
export function repoFiles(env = process.env, root = process.cwd()) {
  const { packages, incomplete } = collectPackages(root);
  const tracked = trackedFiles(root);
  const paths = sendsFileList(env.FMP_SEND_FILE_LIST) ? collectPaths(root, tracked) : null;
  // A yes or no only, sent even with send-file-list off: other package.json files exist that were not sent.
  const morePackages = packages.length > 0 && hasMorePackages(tracked, packages);
  if (!packages.length && !paths) return undefined;
  return {
    ...(packages.length ? { packages } : {}),
    ...(paths ? { paths } : {}),
    ...(incomplete ? { incomplete: true } : {}),
    ...(morePackages ? { morePackages: true } : {}),
  };
}

export async function main(env = process.env) {
  const repo = env.GITHUB_REPOSITORY;
  const ev = readEvent();
  const pr = ev?.pull_request?.number ?? ev?.number ?? null;
  const key = env.FMP_KEY;
  const failBelow = env.FMP_FAIL_BELOW ? Number(env.FMP_FAIL_BELOW) : null;
  if (failBelow !== null && !Number.isFinite(failBelow)) {
    log("fail-below must be a number.");
    return 1;
  }
  if (!repo || !pr) {
    log("This action runs on pull_request events.");
    return 0;
  }
  if (!key) {
    // Pull requests from forks do not receive secrets.
    log("No FMP key available (secrets are not shared with pull requests from forks). Skipping.");
    return 0;
  }

  // A push to the pull request checks only what that push changed; opened and reopened check it all.
  const pushed = await pushPaths(repo, ev);
  const changed = agentFiles(pushed ?? (await changedPaths(repo, pr)));
  if (pushed && !changed.length) {
    log("No agent files changed in this push.");
    return 0;
  }
  const files = changed.filter((p) => {
    if (safeToRead(p)) return true;
    log(`Skipping ${p}: not a regular file inside the workspace.`);
    return false;
  });
  if (!files.length) {
    log("No agent files changed.");
    return 0;
  }

  const extra = repoFiles(env);
  if (extra) {
    const p = extra.packages?.length ?? 0;
    const names = extra.paths ? ` and the names of ${extra.paths.length} files (not their contents)` : "";
    log(`Sending ${p} package.json file${p === 1 ? "" : "s"}${names}. Nothing is stored.`);
  }

  const base = (env.FMP_API_URL || "https://fixmyprompt.net").replace(/\/+$/, "");
  const sent = files.map((path) => ({ path, text: readFileSync(path, "utf8") }));
  const send = (withRepo) =>
    fetch(`${base}/api/doctor/ci`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ files: sent, repo, pr, ...(withRepo && extra ? { repoFiles: extra } : {}) }),
    });
  let res;
  try {
    res = await send(true);
    // Too big with the package.json files and file names: check the agent files alone, once.
    if (res.status === 413 && extra) {
      log("The request was too big with the file names. Checking the agent files without them.");
      res = await send(false);
    }
  } catch {
    // FixMyPrompt never fails the pull request: fail-below is for a real score only.
    log("Could not reach FixMyPrompt. The check passes.");
    return 0;
  }

  let data = null;
  try {
    data = await res.json();
  } catch {}

  if (res.status >= 500) {
    log(`FixMyPrompt is unavailable (${res.status}). The check passes.`);
    return 0;
  }
  if (res.status !== 200) {
    log(`FixMyPrompt answered ${res.status}: ${data?.note ?? data?.error ?? "no detail"}`);
    const existing = await findComment(repo, pr);
    // Free checks used up: keep the last real result on the pull request.
    if (res.status === 402 && existing) {
      log("Kept the existing comment. The check passes.");
      return 0;
    }
    await upsertComment(repo, pr, noteComment(data?.note), existing);
    return 0;
  }

  if (typeof data?.markdown !== "string") {
    log("FixMyPrompt answered without a comment to post. Skipping.");
    return 0;
  }
  await upsertComment(repo, pr, data.markdown);
  const score = data.report?.score;
  log(`Checked ${files.length} file${files.length === 1 ? "" : "s"}. Score ${score}.`);
  if (failBelow !== null && typeof score === "number" && score < failBelow) {
    log(`Score ${score} is below ${failBelow}.`);
    return 1;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      // Only a real score fails the pull request (fail-below); a stopped check passes.
      console.log(`Agent file check stopped: ${e?.message ?? "unknown error"}`);
      process.exit(0);
    },
  );
}
