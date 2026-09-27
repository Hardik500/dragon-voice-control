// Cross-platform release builder. Wraps electron-builder with the parts a raw
// `electron-builder` call gets wrong for this project:
//
//   1. Target gating. A macOS bundle can only be built on macOS -- building one
//      from Linux/Windows silently produces a bundle for the *host's* CPU
//      architecture, so a "arm64" build on an x64 host really ships x64. That
//      artifact looks successful and runs under Rosetta at best, so refuse it
//      here rather than hand someone a mislabelled build.
//   2. One source of truth for what each target is. electron-builder.yml already
//      declares the targets, arch, icons and signing; nothing target-shaped is
//      passed on the command line, so the two cannot drift apart.
//   3. Verification. electron-builder can exit 0 and still leave you with a
//      missing, empty or truncated artifact, so check what actually landed
//      before reporting success.
//
// No Linux target on purpose: automation/index.ts hard-errors off macOS and
// Windows, so a Linux bundle would be something that cannot run.
//
// Usage: node scripts/build-release.js [win|mac]

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const RELEASE_DIR = path.join(ROOT, "release");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

/** An Electron bundle is never this small; a floor like this catches a failed or
 *  truncated build without being brittle about the exact size. */
const MIN_ARTIFACT_BYTES = 20 * 1024 * 1024;

const { version } = require(path.join(ROOT, "package.json"));

/**
 * Windows needs a shell to run .cmd/.bat shims (npm.cmd, electron-builder.cmd), but a shell
 * concatenates arguments without escaping, so any argument containing a space is split in two.
 * Refuse to do that rather than corrupt the call. Everything else runs unshelled, where
 * arguments are passed as an array and spaces are safe. Same rule as scripts/release.js.
 */
function needsShell(cmd, args) {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(cmd)) return false;
  const spaced = args.filter((a) => /\s/.test(a));
  if (spaced.length) {
    throw new Error(
      `Refusing to shell out to ${path.basename(cmd)} with a spaced argument, which the ` +
      `shell would split: ${JSON.stringify(spaced)}`
    );
  }
  return true;
}

function run(cmd, args, label) {
  process.stdout.write(`\n▸ ${label}\n  $ ${cmd} ${args.join(" ")}\n\n`);
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: needsShell(cmd, args), cwd: ROOT });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${label} failed (exit ${res.status})`);
}

/** electron-builder runs rcedit -- a Windows binary -- to append the .exe
 *  extension and stamp the icon onto the packaged executable. On Linux that goes
 *  through wine. Missing it does not just warn: the build produces a PE with no
 *  .exe on it, which Windows will not launch on double-click, carrying Electron's
 *  default icon. Fail early and say so, rather than 20 lines of stack trace. */
function preflight(target) {
  if (target !== "win" || process.platform !== "linux") return;

  const probe = spawnSync("wine", ["--version"], { stdio: "ignore", shell: false });
  if (probe.status === 0) return;

  throw new Error(
    "Building a Windows target on Linux needs wine.\n\n" +
      "  electron-builder runs rcedit to add the .exe extension and stamp the icon.\n" +
      "  Without it you get a valid PE that Windows will not launch on double-click,\n" +
      "  so this is refused rather than shipped.\n\n" +
      "  Either:\n" +
      "    - build on Windows or macOS, where this is a non-issue, or\n" +
      "    - install wine here (Debian/Ubuntu: sudo apt-get install wine64)\n"
  );
}

function builderBin() {
  const name = process.platform === "win32" ? "electron-builder.cmd" : "electron-builder";
  const bin = path.join(ROOT, "node_modules", ".bin", name);
  if (!fs.existsSync(bin)) {
    throw new Error("electron-builder is not installed. Run `npm install` first.");
  }
  return bin;
}

/** Pick the target. With no argument, build for the host platform -- except on
 *  Linux, where the only buildable target is Windows, so require it explicitly
 *  rather than guessing. */
function resolveTarget(arg) {
  if (arg) {
    if (arg !== "win" && arg !== "mac") {
      throw new Error(`Unknown target "${arg}". Use "win" or "mac".`);
    }
    return arg;
  }
  if (process.platform === "win32") return "win";
  if (process.platform === "darwin") return "mac";
  throw new Error(
    "This host is neither Windows nor macOS, so there is no default target.\n" +
      "  A macOS build requires a Mac. A Windows build works from here.\n" +
      "  Run: node scripts/build-release.js win"
  );
}

function explainMacGating() {
  return (
    "\nA macOS bundle can only be produced on a Mac.\n\n" +
    "From Linux or Windows, electron-builder emits a bundle for the *host* CPU\n" +
    "architecture rather than the configured one, so an \"arm64\" build on an x64\n" +
    "host silently ships an x64 app. That artifact looks fine and then needs\n" +
    "Rosetta on an Apple Silicon Mac.\n\n" +
    "Clone the repo on a Mac and run:  node scripts/build-release.js mac\n"
  );
}

function humanSize(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Confirm the artifact is a real, complete, launchable bundle rather than
 *  trusting the exit code. Throws with a specific reason so a broken build is
 *  never reported as a success. */
function verify(target) {
  const expected = target === "win"
    ? `Dragon-${version}-x64-Setup.exe`
    : `Dragon-${version}-arm64.dmg`;
  const suffix = target === "win" ? ".exe" : ".dmg";
  const entries = fs.existsSync(RELEASE_DIR) ? fs.readdirSync(RELEASE_DIR) : [];
  const found = entries.find((n) => n === expected)
    ?? entries.find((n) => n.startsWith("Dragon-") && n.endsWith(suffix));
  if (!found) {
    // Call out the extensionless case specifically: electron-builder can exit 0 and hand
    // back a valid PE with no .exe on it when the executable-editing step is disabled, and
    // the installer would then package an app Windows will not launch. Matched by suffix,
    // not by "has a dot" -- the version alone puts dots in "Dragon-0.1.0-x64". Sidecars the
    // packager legitimately leaves behind (.blockmap, .yml) must not be mistaken for it.
    const extensionless = entries.find(
      (n) => n.startsWith("Dragon-") && !/\.(exe|dmg|app|blockmap|ya?ml|json)$/i.test(n)
    );
    throw new Error(extensionless
      ? `Built ${extensionless}, but it has no .exe extension, so Windows will not launch it on ` +
        `double-click. That happens when signAndEditExecutable is disabled in electron-builder.yml.`
      : `electron-builder exited 0 but produced no ${expected} in release/.`);
  }

  const full = path.join(RELEASE_DIR, found);
  const stat = fs.statSync(full);
  if (!stat.isFile()) throw new Error(`${found} is not a file.`);
  if (stat.size < MIN_ARTIFACT_BYTES) {
    throw new Error(`${found} is only ${humanSize(stat.size)} — that is far too small for a bundled ` +
      `${target === "win" ? "installer" : "disk image"}, so the build is truncated.`);
  }

  const readMagic = (offset, length) => {
    const fd = fs.openSync(full, "r");
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, offset);
    fs.closeSync(fd);
    return buf;
  };

  if (target === "win") {
    // A Windows PE executable starts with "MZ".
    if (readMagic(0, 2).toString("latin1") !== "MZ") {
      throw new Error(`${found} does not start with the PE "MZ" header, so it is not a Windows executable.`);
    }
    // The installer's own name always ends in .exe whatever rcedit did, so checking it proves
    // nothing about the app inside. Check the executable the installer will actually place.
    const appExe = path.join(RELEASE_DIR, "win-unpacked", "Dragon.exe");
    if (!fs.existsSync(appExe)) {
      const bare = path.join(RELEASE_DIR, "win-unpacked", "Dragon");
      throw new Error(fs.existsSync(bare)
        ? `win-unpacked\\Dragon has no .exe extension, so the installed app will not launch on ` +
          `double-click. That happens when signAndEditExecutable is disabled in electron-builder.yml.`
        : `No Dragon.exe in win-unpacked\\, so the installer would package an app with no executable.`);
    }
    return { file: found, size: humanSize(stat.size) };
  }

  // A .dmg is a disk image: a 512-byte trailer beginning "koly" sits at the very end of the
  // file. Checking it is the closest thing to "is this really a dmg" that does not need macOS
  // to mount it.
  if (readMagic(Math.max(0, stat.size - 512), 4).toString("latin1") !== "koly") {
    throw new Error(`${found} has no "koly" disk-image trailer, so it is not a valid .dmg.`);
  }
  return { file: found, size: humanSize(stat.size) };
}

function report(target, result) {
  const path_ = path.join("release", result.file);
  console.log("\n" + "─".repeat(64));
  console.log(`  Built  ${result.file}   (${result.size})`);
  console.log(`  Where  ${path_}`);
  console.log("─".repeat(64));
  console.log("\n  Unsigned, as intended. What the person you send it to will hit:");
  if (target === "win") {
    console.log("    • SmartScreen: 'Windows protected your PC' → More info → Run anyway.");
    console.log("    • One-click installer into the user profile. Never asks for admin.");
    console.log("    • Adds a Start Menu entry, a desktop shortcut, and an uninstaller.");
  } else {
    console.log("    • Open the .dmg and drag Dragon into Applications.");
    console.log("    • Gatekeeper: right-click Dragon.app → Open, and confirm, on first launch only.");
    console.log("    • Unsigned and un-notarized, so it cannot be distributed through the App Store.");
  }
  console.log("\n  Not yet run on its target OS. Verify it before telling anyone it works:\n");
  console.log(target === "win"
    ? "    Launch it, then run: open notepad / start typing / open reddit dot com"
    : "    Launch it, then run: open TextEdit / start typing / open reddit dot com");
  console.log("");
}

function main() {
  const target = resolveTarget(process.argv[2]);

  if (target === "mac" && process.platform !== "darwin") {
    console.error(explainMacGating());
    process.exit(1);
  }
  preflight(target);

  run(NPM, ["run", "build"], "Building TypeScript (clean + main + renderer)");
  run(builderBin(), [`--${target}`], `Packaging ${target} (unsigned)`);

  const result = verify(target);
  report(target, result);
}

try {
  main();
} catch (err) {
  console.error(`\nBuild failed: ${err.message}\n`);
  process.exit(1);
}
