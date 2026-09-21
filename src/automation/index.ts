import * as macos from "./macos";
import * as windows from "./windows";
import { PlatformAutomation } from "./types";
import { logger } from "../logging/logger";

function selectPlatform(): PlatformAutomation {
  if (process.platform === "darwin") return macos satisfies PlatformAutomation;
  if (process.platform === "win32") return windows satisfies PlatformAutomation;
  if (process.platform === "linux") {
    // Dragon does not support Linux for end users (see DECISIONS.md) — this whole project has
    // been developed and typechecked on a Linux sandbox with no macOS/Windows machine
    // available, though, so this dev-only fallback lets the app still boot for structural
    // verification (tray/windows/IPC/logging). The macOS shell commands will simply fail at
    // runtime if actually invoked here, which is expected and fine for that purpose.
    logger.event("automation.unsupported_platform_dev_fallback", { platform: process.platform });
    return macos satisfies PlatformAutomation;
  }
  throw new Error(
    `Dragon supports macOS (darwin) and Windows (win32) only; unsupported platform: ${process.platform}`
  );
}

/** The pipeline and decision layers import this, never `./macos` or `./windows` directly. */
export const automation: PlatformAutomation = selectPlatform();
