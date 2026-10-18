import * as fs from "fs";
import * as path from "path";

/** Write beside the destination and rename, so an interrupted save keeps the old JSON. */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = filePath + "." + process.pid + ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* Rename already consumed it. */ }
  }
}
