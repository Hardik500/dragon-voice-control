import { clipboard } from "electron";
import { logger } from "../logging/logger";

let pasteQueue: Promise<void> = Promise.resolve();

/** Restore common rich clipboard formats only while Dragon still owns the temporary text. */
export function pasteText(text: string, paste: () => Promise<void>): Promise<void> {
  const run = async () => {
    const previous: Electron.Data = {};
    const originalFormats = clipboard.availableFormats();
    const plain = clipboard.readText(), html = clipboard.readHTML(), rtf = clipboard.readRTF();
    const image = clipboard.readImage(), bookmark = clipboard.readBookmark();
    if (plain || originalFormats.includes("text/plain")) previous.text = plain;
    if (html) previous.html = html;
    if (rtf) previous.rtf = rtf;
    if (!image.isEmpty()) previous.image = image;
    if (bookmark.title && bookmark.url === plain) previous.bookmark = bookmark.title;
    if (originalFormats.length && Object.keys(previous).length === 0) {
      throw new Error("Clipboard contains files or app data Dragon cannot preserve. Copy text to the clipboard, then try typing again.");
    }
    clipboard.writeText(text);
    const formats = clipboard.availableFormats().sort().join("\n");
    try { await paste(); }
    finally {
      // The target consumes Ctrl/Cmd+V asynchronously. Serialize this ownership interval.
      await new Promise(resolve => setTimeout(resolve, 400));
      try {
        if (clipboard.readText() === text && clipboard.availableFormats().sort().join("\n") === formats) {
          if (Object.keys(previous).length) clipboard.write(previous);
          else clipboard.clear();
        }
      } catch (error) { logger.error("automation.clipboard_restore", error); }
    }
  };
  const result = pasteQueue.then(run, run);
  pasteQueue = result.catch(() => {});
  return result;
}
