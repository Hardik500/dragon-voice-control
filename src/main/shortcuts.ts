import { globalShortcut } from "electron";
import { logger } from "../logging/logger";

export interface ShortcutRegistrationStatus {
  pushToTalkOk: boolean;
  emergencyStopOk: boolean;
  insertModeOk: boolean;
  workflowModeOk: boolean;
}

export function registerShortcuts(opts: {
  pushToTalkAccelerator: string;
  emergencyStopAccelerator: string;
  insertModeAccelerator: string;
  workflowModeAccelerator: string;
  onPushToTalk: () => void;
  onEmergencyStop: () => void;
  onToggleInsertMode: () => void;
  onToggleWorkflowMode: () => void;
}): ShortcutRegistrationStatus {
  globalShortcut.unregisterAll();
  const tryRegister = (accelerator: string, callback: () => void): boolean => {
    try {
      return globalShortcut.register(accelerator, callback);
    } catch {
      return false;
    }
  };
  const pushToTalkOk = tryRegister(opts.pushToTalkAccelerator, opts.onPushToTalk);
  const emergencyStopOk = tryRegister(opts.emergencyStopAccelerator, opts.onEmergencyStop);
  const insertModeOk = tryRegister(opts.insertModeAccelerator, opts.onToggleInsertMode);
  const workflowModeOk = tryRegister(opts.workflowModeAccelerator, opts.onToggleWorkflowMode);
  logger.event("shortcuts.registered", {
    pushToTalk: opts.pushToTalkAccelerator,
    pushToTalkOk,
    emergencyStop: opts.emergencyStopAccelerator,
    emergencyStopOk,
    insertMode: opts.insertModeAccelerator,
    insertModeOk,
    workflowMode: opts.workflowModeAccelerator,
    workflowModeOk,
  });
  return { pushToTalkOk, emergencyStopOk, insertModeOk, workflowModeOk };
}

export function unregisterShortcuts() {
  globalShortcut.unregisterAll();
}
