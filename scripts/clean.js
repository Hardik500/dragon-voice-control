// Cross-platform replacement for `rm -rf dist dist-renderer` (Windows has no `rm`).
const fs = require("fs");
const path = require("path");

for (const dir of ["dist", "dist-renderer"]) {
  fs.rmSync(path.join(__dirname, "..", dir), { recursive: true, force: true });
}
