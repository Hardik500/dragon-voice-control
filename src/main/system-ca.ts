import { execFileSync } from "child_process";
// `import * as tls` compiles to `__importStar(require("tls"))`, which copies the module's
// properties onto a new object -- mutating that copy doesn't touch the live `tls` module that
// `ws`/`fetch` actually `require()`, so the monkey-patch below silently does nothing. `import
// tls = require(...)` is TS's alias for a plain `require`, which returns Node's real cached
// module object, and that's the one everything else shares.
import tls = require("tls");
import { logger } from "../logging/logger";

/**
 * Node's bundled CA store doesn't include roots installed in the OS trust store by corporate
 * MDM TLS-inspection proxies. Chrome/curl trust those fine because they read the OS trust
 * store directly; Node-based connections (the `ws` socket to Deepgram, `fetch` to OpenRouter
 * for Jev and to the vision model) don't, and fail with SELF_SIGNED_CERT_IN_CHAIN or
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE even though the API's own certificate is genuine. Node 22.9
 * added a `--use-system-ca` flag for exactly this; Electron 33 bundles Node 20, which doesn't
 * have it. `NODE_EXTRA_CA_CERTS` was tried first and does NOT work -- Node/Electron's TLS
 * defaults get cached before that env var takes effect, even when set at the top of
 * `app.whenReady()`. What does work: monkey-patching `tls.createSecureContext` so every secure
 * context that doesn't pass its own `ca` gets the OS store's certs merged into Node's bundled
 * roots. That is the one choke point both `ws` and Node's built-in `fetch` (undici) go through,
 * so patching it once here covers every outbound HTTPS/WSS call without touching a call site.
 *
 * Where those extra certs come from, per platform:
 * - macOS: the System keychain (`security find-certificate`), which is where MDM pushes its
 *   root. This was reported and fixed there first.
 * - Windows: both `Root` certificate stores (`LocalMachine` and `CurrentUser`), which is where
 *   MDM/inspection agents install theirs. Same failure mode, and it was not covered at all
 *   before: this function used to return immediately on any host that wasn't `darwin`, so
 *   Windows ran on Node's bundled CAs only.
 *
 * No-op elsewhere (the Linux dev host).
 */
export function trustSystemCaCerts(): void {
  let certs: string[];
  try {
    certs = readSystemCerts();
  } catch (err) {
    // stderr is part of the diagnosis here: the common Windows cause is an AppLocker/WDAC
    // policy refusing powershell.exe, and the command's own stderr says so where the Node
    // error message ("Command failed: ...") does not. String() because execFileSync hands back
    // a Buffer when no encoding is set, and `??` would keep an empty string.
    const stderr = (err as { stderr?: unknown })?.stderr ? String((err as { stderr: unknown }).stderr) : "";
    logger.error("main.system_ca_load_failed", err, { platform: process.platform, stderr: stderr.trim() });
    return;
  }
  // Deliberately NOT `if (certs.length === 0) return`. A silent no-op here is indistinguishable
  // from the code not having run at all (e.g. a stale build), which is exactly the ambiguity
  // that made a Windows TLS failure undiagnosable from the log. Zero is a legitimate result
  // and gets logged as such.
  mergeIntoDefaultTlsOptions(certs);
  // `platform` says which branch ran; the per-store counts/errors say which certificate store
  // produced what, so a zero on Windows is attributable rather than a guess.
  logger.event("main.system_ca_loaded", {
    platform: process.platform,
    certCount: certs.length,
    ...storeDiagnostics,
  });
}

function readSystemCerts(): string[] {
  if (process.platform === "darwin") return readMacosSystemKeychain();
  if (process.platform === "win32") return readWindowsRootStores();
  return [];
}

function splitPem(pem: string): string[] {
  return pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
}

function readMacosSystemKeychain(): string[] {
  const pem = execFileSync("security", ["find-certificate", "-a", "-p", "/Library/Keychains/System.keychain"], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return splitPem(pem);
}

/**
 * Emits both Windows `Root` stores as PEM on stdout, preceded by `#`-prefixed diagnostic lines
 * (`#store <location> <count>` / `#error <location> <message>`) that this module parses out of
 * stdout and puts in the log. They ride on stdout rather than stderr on purpose: `execFileSync`
 * surfaces stderr only as part of a thrown error's message, which is lost on the success path,
 * and a silent zero is precisely the case worth being able to explain.
 *
 * - Reads via .NET's `X509Store` rather than the `Cert:` PowerShell drive. The drive is a
 *   convenience layer supplied by a PowerShell module; going straight to the API cannot fail
 *   because that module is blocked or unavailable under AppLocker/WDAC, which is a real
 *   configuration on locked-down corporate machines and fails silently.
 * - Both stores are read because a locally-installed inspection root can land in either, and
 *   each is independently try/caught so one unreadable store can't hide the other's certs.
 *   Reading `LocalMachine\Root` does not require elevation.
 * - `$cert.RawData` is the certificate's DER bytes, so base64-ing that is enough. The obvious
 *   alternative, `Export-Certificate`, takes one file path per certificate, which is
 *   unacceptable for a store that routinely holds 300-400 entries.
 * - Thumbprint-deduped, because a root present in both stores would otherwise be handed to
 *   OpenSSL twice.
 * - The `$b64` AppendLine is load-bearing and must not be "simplified" into a plain Append:
 *   `InsertLineBreaks` breaks every 64 chars but emits no trailing break, and if the final
 *   base64 chunk ends up glued to the `END` armour, Node silently drops that certificate -- no
 *   error at load, just an UNABLE_TO_GET_ISSUER_CERT_LOCALLY at connect time.
 * - Output is pure ASCII (base64 + PEM armour), so it survives whatever OEM code page the
 *   console host is using without forcing an encoding.
 */
const WINDOWS_ROOT_CERT_SCRIPT = [
  "$sb = New-Object System.Text.StringBuilder",
  "$seen = @{}",
  'foreach ($loc in @("LocalMachine", "CurrentUser")) {',
  "  $count = 0",
  "  try {",
  "    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store -ArgumentList \"Root\", $loc",
  "    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)",
  "    try {",
  "      foreach ($cert in $store.Certificates) {",
  "        if ($seen.ContainsKey($cert.Thumbprint)) { continue }",
  "        $seen[$cert.Thumbprint] = $true",
  "        $count++",
  '        $b64 = [Convert]::ToBase64String($cert.RawData, "InsertLineBreaks")',
  '        [void]$sb.AppendLine("-----BEGIN CERTIFICATE-----")',
  "        [void]$sb.AppendLine($b64)",
  '        [void]$sb.AppendLine("-----END CERTIFICATE-----")',
  "      }",
  "    } finally { $store.Close() }",
  '    Write-Output "#store $loc $count"',
  "  } catch {",
  '    Write-Output "#error $loc $($_.Exception.Message)"',
  "  }",
  "}",
  "Write-Output $sb.ToString()",
].join("\n");

/** Per-store results from the last Windows read, folded into the `main.system_ca_loaded` log. */
let storeDiagnostics: Record<string, unknown> = {};

function readWindowsRootStores(): string[] {
  const pem = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_ROOT_CERT_SCRIPT], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    // This runs synchronously on the startup path, before `app.whenReady()`, so a wedged or
    // policy-blocked `powershell.exe` must not be able to hang app launch indefinitely. If the
    // timeout fires, the throw is caught above and logged as `main.system_ca_load_failed`.
    timeout: 20_000,
    windowsHide: true,
    // stderr is captured rather than inherited so it can be logged if this throws -- that is the
    // only path where a PowerShell policy refusal or script error becomes visible at all.
    stdio: ["ignore", "pipe", "pipe"],
  });
  storeDiagnostics = {};
  for (const line of pem.split("\n")) {
    if (!line.startsWith("#")) continue;
    // e.g. "#store LocalMachine 412" or "#error CurrentUser <message>"
    const [tag, location, ...rest] = line.trim().split(/\s+/);
    if (tag === "#store") storeDiagnostics[location] = Number(rest[0]);
    else if (tag === "#error") storeDiagnostics[`${location}_error`] = rest.join(" ");
  }
  return splitPem(pem);
}

function mergeIntoDefaultTlsOptions(extraCerts: string[]): void {
  // Merged with, never replacing, Node's bundled roots -- otherwise adding one corporate proxy
  // root would silently un-trust every public CA.
  const merged = [...tls.rootCertificates, ...extraCerts];
  const origCreateSecureContext = tls.createSecureContext;
  (tls as { createSecureContext: typeof tls.createSecureContext }).createSecureContext = function (
    options?: tls.SecureContextOptions
  ) {
    const opts = options ? { ...options } : {};
    if (!opts.ca) opts.ca = merged;
    return origCreateSecureContext(opts);
  };
}
