import { globalShortcut } from "electron";
import { logger } from "../logging/logger";

export function registerShortcuts(opts: {
  pushToTalkAccelerator: string;
  emergencyStopAccelerator: string;
  onPushToTalk: () => void;
  onEmergencyStop: () => void;
}) {
  globalShortcut.unregisterAll();
  const ok1 = globalShortcut.register(opts.pushToTalkAccelerator, opts.onPushToTalk);
  const ok2 = globalShortcut.register(opts.emergencyStopAccelerator, opts.onEmergencyStop);
  logger.event("shortcuts.registered", {
    pushToTalk: opts.pushToTalkAccelerator,
    pushToTalkOk: ok1,
    emergencyStop: opts.emergencyStopAccelerator,
    emergencyStopOk: ok2,
  });
}

export function unregisterShortcuts() {
  globalShortcut.unregisterAll();
}
