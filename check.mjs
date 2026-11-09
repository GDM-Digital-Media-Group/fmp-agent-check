// Agent file check for pull requests. Node built-ins only (global fetch, fs, path).
// Lists the files the pull request changes through the GitHub REST API (works on
// shallow checkouts, needs no git history), or on a later push only the files
// that push changed, reads the agent files from the checkout, sends them to
// FixMyPrompt and posts or updates one marked comment. Only a score below
// fail-below fails the check; FixMyPrompt being unreachable, down or out of
// free checks never does.
import { readFileSync, lstatSync, realpathSync } from "node:fs";
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

  const base = (env.FMP_API_URL || "https://fixmyprompt.net").replace(/\/+$/, "");
  let res;
  try {
    res = await fetch(`${base}/api/doctor/ci`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ files: files.map((path) => ({ path, text: readFileSync(path, "utf8") })), repo, pr }),
    });
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
