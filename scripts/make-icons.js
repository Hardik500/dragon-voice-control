// Generates minimal placeholder PNG icons for the tray and app, with no
// external dependencies. Produces a simple filled-circle "template" image
// (black shape + alpha) suitable for macOS menu-bar tray icons.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/** Renders a simple filled circle (with a small notch, dragon-ish silhouette is overkill for an alpha). */
function makeCirclePng(size) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.38;
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const dx = x - cx + 0.5;
      const dy = y - cy + 0.5;
      const inside = dx * dx + dy * dy <= r * r;
      const off = rowStart + 1 + x * 4;
      raw[off] = 0; // R (black shape; alpha carries the shape for a macOS template image)
      raw[off + 1] = 0; // G
      raw[off + 2] = 0; // B
      raw[off + 3] = inside ? 255 : 0; // A
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = zlib.deflateSync(raw);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/** Same shape as makeCirclePng, but filled with a solid color — used for Windows, which
 * (unlike macOS) does not auto-tint monochrome "template" tray icons. */
function makeColorCirclePng(size, [r, g, b]) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.44;
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      const dx = x - cx + 0.5;
      const dy = y - cy + 0.5;
      const inside = dx * dx + dy * dy <= radius * radius;
      const off = rowStart + 1 + x * 4;
      raw[off] = inside ? r : 0;
      raw[off + 1] = inside ? g : 0;
      raw[off + 2] = inside ? b : 0;
      raw[off + 3] = inside ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlib.deflateSync(raw);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/** Packs PNGs into a Windows .ico container (PNG-compressed icon directory entries, valid
 * since Windows Vista — no BMP/DIB conversion needed). */
function makeIco(pngsBySize) {
  const sizes = Object.keys(pngsBySize).map(Number).sort((a, b) => a - b);
  const count = sizes.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const entries = [];
  const images = [];
  let offset = 6 + count * 16;
  for (const size of sizes) {
    const png = pngsBySize[size];
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // 0 means 256
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // color count
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bit count
    entry.writeUInt32LE(png.length, 8); // bytes in resource
    entry.writeUInt32LE(offset, 12); // image offset
    entries.push(entry);
    images.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images]);
}

const assetsDir = path.join(__dirname, "..", "assets");
fs.mkdirSync(assetsDir, { recursive: true });
fs.writeFileSync(path.join(assetsDir, "tray-icon.png"), makeCirclePng(16));
fs.writeFileSync(path.join(assetsDir, "tray-icon@2x.png"), makeCirclePng(32));
fs.writeFileSync(path.join(assetsDir, "app-icon-512.png"), makeCirclePng(512));

const DRAGON_ORANGE = [217, 83, 45];
fs.writeFileSync(path.join(assetsDir, "tray-icon-win.png"), makeColorCirclePng(32, DRAGON_ORANGE));
const icoSizes = [16, 32, 48, 256];
const icoPngs = {};
for (const size of icoSizes) icoPngs[size] = makeColorCirclePng(size, DRAGON_ORANGE);
fs.writeFileSync(path.join(assetsDir, "app-icon.ico"), makeIco(icoPngs));

console.log("Wrote assets/tray-icon.png, tray-icon@2x.png, tray-icon-win.png, app-icon-512.png, app-icon.ico");
