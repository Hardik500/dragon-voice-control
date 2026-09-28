import { execFileSync } from "child_process";
// `import * as tls` compiles to `__importStar(require("tls"))`, which copies the module's
// properties onto a new object -- mutating that copy doesn't touch the live `tls` module that
// `ws`/`fetch` actually `require()`, so the monkey-patch below silently does nothing. `import
// tls = require(...)` is TS's alias for a plain `require`, which returns Node's real cached
// module object, and that's the one everything else shares.
import tls = require("tls");
import { logger } from "../logging/logger";

/**
 * Node's bundled CA store doesn't include roots injected into the OS trust store by corporate
 * MDM TLS-inspection proxies. Chrome/curl trust those fine because they read the
 * OS trust store directly; Node-based connections (the `ws` socket to Deepgram, `fetch` to
 * OpenRouter for Jev) don't, and fail with "self signed certificate in certificate chain"
 * (SELF_SIGNED_CERT_IN_CHAIN) even though the API's own certificate is genuine. Node 22.9 added
 * a `--use-system-ca` flag for exactly this; Electron 33 bundles Node 20, which doesn't have it.
 * `NODE_EXTRA_CA_CERTS` was tried first and does NOT work here -- verified against a real
 * Electron process that Node/Electron's TLS defaults get cached before that env var takes
 * effect, even when set at the very start of `app.whenReady()`. What does work, verified the
 * same way for both the `ws` socket and `fetch`: monkey-patching `tls.createSecureContext` so
 * every secure context that doesn't pass its own `ca` gets the system keychain's certs merged
 * in. This is the one choke point both `ws` and Node's built-in `fetch` (undici) go through, so
 * patching it once here covers every network call without touching each call site.
 * macOS only -- not reported on Windows.
 */
export function trustSystemCaCerts(): void {
  if (process.platform !== "darwin") return;
  try {
    const pem = execFileSync("security", ["find-certificate", "-a", "-p", "/Library/Keychains/System.keychain"], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    const certs = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
    if (certs.length === 0) return;
    const merged = [...tls.rootCertificates, ...certs];
    const origCreateSecureContext = tls.createSecureContext;
    (tls as { createSecureContext: typeof tls.createSecureContext }).createSecureContext = function (
      options?: tls.SecureContextOptions
    ) {
      const opts = options ? { ...options } : {};
      if (!opts.ca) opts.ca = merged;
      return origCreateSecureContext(opts);
    };
    logger.event("main.system_ca_loaded", { certCount: certs.length });
  } catch (err) {
    logger.error("main.system_ca_load_failed", err);
  }
}
