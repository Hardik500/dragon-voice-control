// Cross-platform release publisher.
//
// The problem this solves: Windows and macOS builds happen on different
// machines, so one version number is produced in two runs. This script makes
// those two runs converge on a single release instead of forking it.
//
// Model -- a release *cycle* is one version number, shared by both platforms:
//
//   latest release has my platform's artifact   -> already shipped, do nothing
//   latest release has only the other platform's -> join that cycle, upload mine
//   otherwise                                   -> start a new cycle, create it
//
// So the first platform to run creates the release and the second joins it. A
// new cycle only begins once the current one holds both platforms' artifacts,
// which is what stops repeated runs from bumping forever on a machine that
// only ever builds one platform.
//
// Usage:
//   node scripts/release.js                 # publish for the current platform, always
//   node scripts/release.js --dry-run       # print the plan, change nothing
//   node scripts/release.js --minor         # bump 0.1.1 -> 0.2.0
//   node scripts/release.js --notes-file NOTES.md
//   node scripts/release.js --force-new     # new cycle even if the last is incomplete
//
// There is no draft mode. A release is published the moment it is created, and the
// other platform attaches to it whenever its machine runs this.

const fs = require("fs");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PKG_PATH = path.join(ROOT, "package.json");
const RELEASE_DIR = path.join(ROOT, "release");
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

/** What each platform contributes to a release. */
const PLATFORM = IS_WIN
  ? { name: "Windows", asset: /\.exe$/i }
  : IS_MAC
    ? { name: "macOS", asset: /\.app\.zip$/i }
    : null;

function die(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}

/**
 * Windows needs a shell to run .cmd/.bat shims, but a shell concatenates arguments
 * without escaping, so any argument containing a space is split in two. That is not
 * theoretical: `git commit -m "release: v0.1.0"` becomes `git commit -m "release:" v0.1.0`
 * and dies with "error: pathspec 'v0.1.0' did not match any file(s) known to git".
 * Verified against real git, both ways.
 *
 * So: use a shell only for .cmd/.bat, and refuse to do it with a spaced argument rather
 * than let it corrupt the call. Everything else -- git, gh, ditto, node.exe -- runs
 * unshelled, where arguments are passed as an array and spaces are safe.
 */
function needsShell(cmd, args) {
  if (!IS_WIN || !/\.(cmd|bat)$/i.test(cmd)) return false;
  const spaced = args.filter((a) => /\s/.test(a));
  if (spaced.length) {
    throw new Error(
      `Refusing to shell out to ${path.basename(cmd)} with a spaced argument, which the ` +
      `shell would split: ${JSON.stringify(spaced)}\n` +
      `  .cmd shims require a shell on Windows, so the argument has to be space-free.`
    );
  }
  return true;
}

function run(cmd, args, label) {
  if (label) console.log(`  $ ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: needsShell(cmd, args), cwd: ROOT });
  if (res.error) throw res.error;
  if (res.status !== 0) die(`${label || cmd} failed (exit ${res.status})`);
}

function capture(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", shell: needsShell(cmd, args), cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
}

function git(...args) {
  return capture("git", args).trim();
}

function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) die(`package.json version "${v}" is not plain X.Y.Z; bump it by hand.`);
  return m.slice(1, 4).map(Number);
}

function bump(v, kind) {
  const [maj, min, pat] = parse(v);
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  // Roll over rather than producing 0.1.100.
  if (pat === 99) return min === 99 ? `${maj + 1}.0.0` : `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

/** Read a release's attached asset names, or null if they cannot be read. `gh release list`
 *  does not expose assets at all — only `gh release view` does — so this is a second call. */
function assetNames(tag) {
  try {
    const out = capture("gh", ["release", "view", tag, "--json", "assets"]);
    const rel = JSON.parse(out || "{}");
    return (rel.assets || []).map((a) => a.name);
  } catch {
    return null;
  }
}

function latestRelease() {
  // Drafts are included by default. Nothing creates one any more, but a release staged before
  // that changed must still be found and joined rather than silently superseded.
  const out = capture("gh", ["release", "list", "--limit", "1", "--json", "tagName,isDraft"]);
  const list = JSON.parse(out || "[]");
  if (!list.length) return null;
  const rel = list[0];
  // `tag` is the bare version (for bumping and artifact names); `ref` is the real git
  // tag, which carries the leading "v" and is what git needs.
  return { tag: rel.tagName.replace(/^v/, ""), ref: rel.tagName, names: assetNames(rel.tagName), isDraft: rel.isDraft };
}

/**
 * Decide what this run should do. Pure, so the cycle rules can be exercised
 * without a Windows/Mac host or a live release.
 *
 * `commitsSinceTag` is the load-bearing signal, not artifact presence: it is what
 * separates "someone added the other platform's build" (join, no new version)
 * from "there is unreleased work" (new version). Checking artifacts first would
 * make a completed release permanently un-releasable, and re-running by accident
 * would churn versions.
 *
 *   no release at all                             -> create at the package.json version
 *   nothing new since the tag, I already shipped  -> 'none'
 *   nothing new since the tag, I'm missing        -> 'upload', join it
 *   unreleased work                               -> 'create', bumped
 */
function decideCycle(latest, myAssetPattern, kind, pkgVersion, forceNew, commitsSinceTag) {
  // `names` is null when the assets could not be read. Treating that as "I have no artifact"
  // degrades to attaching to the existing release, which never bumps spuriously.
  const mine = (rel) => !!rel && !!rel.names && rel.names.some((n) => myAssetPattern.test(n));
  const unreleased = forceNew || !latest || commitsSinceTag > 0;

  if (!unreleased) {
    return mine(latest)
      ? { action: "none", version: latest.tag }
      : { action: "upload", version: latest.tag };
  }
  if (latest && !mine(latest)) {
    // A new cycle is warranted, but this platform's artifact is still the missing half of the
    // previous one — finish that release rather than leaving it permanently incomplete.
    return { action: "upload", version: latest.tag };
  }
  return { action: "create", version: latest ? bump(latest.tag, kind) : pkgVersion };
}

/**
 * Notes for a release that is published the moment this machine creates it — which may be
 * before the other platform has attached its build. So nothing here may assert that a
 * particular file is present. The per-platform caveats are stated unconditionally, because
 * they are true either way, and the attachment list on the release page is the source of
 * truth for what is actually there.
 */
function defaultNotes(version) {
  return [
    `Dragon v${version}. Personal alpha — unsigned, no automated tests, expect bugs.`,
    "",
    "**macOS** (Apple Silicon) — right-click Dragon.app → Open on first launch to clear",
    "Gatekeeper. Unsigned and un-notarized, so it cannot be distributed through the App Store.",
    "",
    "**Windows** (x64) — one portable file, nothing installed. SmartScreen will say",
    '"Windows protected your PC" → More info → Run anyway. A new download has no reputation,',
    "so expect that prompt every time.",
    "",
    "Both platforms are supported and equally expected to have rough edges. Recent work has",
    "landed on Windows; macOS was last verified several commits earlier.",
    "",
    "Needs a Deepgram key and an OpenRouter key with System One access, pasted into Settings on",
    "first launch. There is no installer and no auto-update — grab a new build from here.",
  ].join("\n");
}

/** macOS .app bundles are directories, so they must be zipped before upload — and a plain
 *  `zip` drops the executable bit, producing an app that will not launch. `ditto` is Apple's
 *  tool for exactly this. */
function packageMac(version) {
  const appDir = path.join(RELEASE_DIR, `Dragon-${version}-arm64.app`);
  if (!fs.existsSync(appDir)) die(`Expected ${appDir} to exist after the mac build.`);
  const zip = path.join(RELEASE_DIR, `Dragon-${version}-arm64.app.zip`);
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appDir, zip], "Zipping the .app (ditto preserves the exec bit)");
  return zip;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const forceNew = args.includes("--force-new");
  const kind = args.includes("--major") ? "major" : args.includes("--minor") ? "minor" : "patch";
  const nfIdx = args.indexOf("--notes-file");
  const notesFile = nfIdx >= 0 ? args[nfIdx + 1] : null;
  const unknown = args.filter((a) =>
    !["--dry-run", "--force-new", "--major", "--minor", "--notes-file"].includes(a) && a !== notesFile);
  if (unknown.length) die(`Unknown argument(s): ${unknown.join(", ")}`);
  if (!PLATFORM) die("Dragon ships for macOS and Windows only. Run this on one of those.");

  // --- preflight -------------------------------------------------------
  try { capture("gh", ["auth", "status"]); }
  catch { die("Not signed in to GitHub. Run `gh auth login` first."); }

  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") die(`Release from main, not "${branch}".`);
  const dirty = git("status", "--porcelain");
  if (dirty) die("Working tree is not clean. Commit or stash first:\n" + dirty);

  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));
  const latest = latestRelease();

  // Commits since the latest tag are what say whether there is unreleased work. The tag may
  // not exist locally (fresh clone, or a draft release, which has no tag until it is
  // published), so fetch tags first and treat an unresolvable tag as "count unknown".
  let commitsSinceTag = 0;
  if (latest) {
    try { capture("git", ["fetch", "--tags", "--quiet"]); } catch { /* non-fatal */ }
    try {
      commitsSinceTag = Number(git("rev-list", "--count", `${latest.ref}..HEAD`));
    } catch {
      commitsSinceTag = 0;
      console.log(`\n  Note: tag ${latest.ref} isn't in this clone${latest.isDraft ? " (expected for a draft)" : ""}.`);
      console.log(`  Assuming nothing has been committed since it. Use --force-new to cut a version anyway.`);
    }
  }
  if (latest && latest.names === null) {
    console.log(`\n  Note: couldn't read the assets on ${latest.ref}.`);
    console.log(`  Attaching to it rather than bumping, which is the safe direction.`);
  }

  // --- decide the cycle ------------------------------------------------
  const decision = decideCycle(latest, PLATFORM.asset, kind, pkg.version, forceNew, commitsSinceTag);
  const { action, version } = decision;

  if (action === "none") {
    // There is nothing to build, but a draft is still a release nobody can see. This is exactly
    // the state a release is left in when one machine staged it and the other never arrived, so
    // publish it here rather than let "nothing to do" mean "silently left invisible". A draft
    // also has no git tag, which is why the commit count above could not be read and defaulted
    // to zero; publishing is still the right call, and --force-new is the escape hatch if the
    // default was wrong.
    if (latest && latest.isDraft) {
      console.log(`\n  v${version} is still a draft from an earlier run — publishing it.`);
      run("gh", ["release", "edit", `v${version}`, "--draft=false"], `Publishing v${version}`);
      console.log(`  https://github.com/Hardik500/dragon-voice-control/releases/tag/v${version}`);
    }
    console.log(`\n  v${version} already ships a ${PLATFORM.name} artifact and nothing has been`);
    console.log(`  committed since. Nothing else to do — use --force-new to cut a version anyway.\n`);
    return;
  }

  const notes = notesFile ? fs.readFileSync(path.resolve(notesFile), "utf8") : defaultNotes(version);
  const notesPath = path.join(ROOT, ".release-notes.tmp.md");
  fs.writeFileSync(notesPath, notes);

  console.log(`\n  ${PLATFORM.name} · ${action === "create" ? "new release" : "joining existing release"}`);
  console.log(`  version  v${version}${version !== pkg.version ? `  (package.json: ${pkg.version} → ${version})` : ""}`);
  console.log(`  based on ${latest ? `v${latest.tag}` : "no existing release"}`);
  if (dryRun) {
    console.log("\n  --dry-run: stopping before any change.\n");
    return;
  }

  // --- sync package.json so the artifact name matches the release -----
  if (pkg.version !== version) {
    pkg.version = version;
    fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");
    run("git", ["add", "package.json"], null);
    run("git", ["commit", "-m", `release: v${version}`], null);
  }

  // --- push main, then build (so the tag lands on the right commit) ----
  // If the count cannot be read (no origin/main ref yet), push anyway: that is a no-op
  // when already up to date, and it either fast-forwards or fails with git's own message.
  // Aborting here would fail a release over a ref that may not exist yet.
  let ahead = null;
  try { ahead = Number(git("rev-list", "--count", "origin/main..HEAD")); } catch { /* unknown */ }
  if (ahead === null) {
    console.log("  origin/main not resolvable locally — pushing anyway");
    run("git", ["push", "origin", "main"], null);
  } else if (ahead > 0) {
    console.log(`  pushing ${ahead} commit(s) to main`);
    run("git", ["push", "origin", "main"], null);
  }

  console.log("");
  run(process.execPath, [path.join(__dirname, "build-release.js"), IS_WIN ? "win" : "mac"], `Building ${PLATFORM.name}`);

  const asset = IS_WIN
    ? path.join(RELEASE_DIR, `Dragon-${version}-x64.exe`)
    : packageMac(version);
  if (!fs.existsSync(asset)) die(`Expected artifact missing: ${asset}`);

  // --- create or join --------------------------------------------------
  // Always published. A draft would mean the release sits invisible until somebody remembers to
  // promote it, and the thing that would be waiting is usually the other platform's machine
  // arriving hours or days later. Publishing now is the safe direction: `gh release upload`
  // attaches to a live release just as happily, so the second platform can still join it.
  const tag = `v${version}`;
  if (action === "create") {
    run("gh", ["release", "create", tag, asset, "--title", `Dragon ${tag}`, "--notes-file", notesPath], null);
  } else {
    console.log(`  v${version} already exists — attaching the ${PLATFORM.name} artifact.`);
    run("gh", ["release", "upload", tag, asset, "--clobber"], null);
    // Nothing creates drafts any more, but one may exist from an older run. Promote it here
    // rather than leave a release that only exists to whoever remembers to look for it.
    if (latest && latest.isDraft) {
      console.log("  it was a draft — publishing it now so nobody has to remember to.");
      run("gh", ["release", "edit", tag, "--draft=false"], null);
    }
  }

  fs.unlinkSync(notesPath);

  console.log("\n" + "─".repeat(64));
  console.log(`  ${action === "create" ? "Published" : "Added to"} ${tag} — ${PLATFORM.name} build attached.`);
  const other = IS_WIN ? "macOS" : "Windows";
  if (action === "create") {
    console.log(`  ${other} is not attached yet. Run this same command on a ${other} machine and it will join this release.`);
  }
  console.log(`  https://github.com/Hardik500/dragon-voice-control/releases/tag/${tag}`);
  console.log("─".repeat(64) + "\n");
}

try {
  if (require.main === module) main();
} catch (err) {
  try { fs.unlinkSync(path.join(ROOT, ".release-notes.tmp.md")); } catch { /* ignore */ }
  console.error(`\nRelease failed: ${err.message}\n`);
  process.exit(1);
}

module.exports = { decideCycle, bump, parse, defaultNotes };
