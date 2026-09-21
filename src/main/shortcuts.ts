import { globalShortcut } from "electron";
import { logger } from "../logging/logger";

export interface ShortcutRegistrationStatus {
  pushToTalkOk: boolean;
  emergencyStopOk: boolean;
}

export function registerShortcuts(opts: {
  pushToTalkAccelerator: string;
  emergencyStopAccelerator: string;
  onPushToTalk: () => void;
  onEmergencyStop: () => void;
}): ShortcutRegistrationStatus {
  globalShortcut.unregisterAll();
  const pushToTalkOk = globalShortcut.register(opts.pushToTalkAccelerator, opts.onPushToTalk);
  const emergencyStopOk = globalShortcut.register(opts.emergencyStopAccelerator, opts.onEmergencyStop);
  logger.event("shortcuts.registered", {
    pushToTalk: opts.pushToTalkAccelerator,
    pushToTalkOk,
    emergencyStop: opts.emergencyStopAccelerator,
    emergencyStopOk,
  });
  return { pushToTalkOk, emergencyStopOk };
}

export function unregisterShortcuts() {
  globalShortcut.unregisterAll();
}
