// Draws the marketplace icon (a pi glyph on a rounded indigo tile) into resources/icon.png.
// Hand-rolled so the repo needs no image toolchain: raw RGBA rows, zlib, a PNG container.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 128;
const RADIUS = 28;
const BG_TOP = [0x2a, 0x21, 0x4a];
const BG_BOTTOM = [0x16, 0x12, 0x2c];
const INK = [0xf2, 0xee, 0xff];

const px = Buffer.alloc(S * S * 4);

/** Distance-to-tile test that keeps the corners round and the edges crisp. */
function coverage(x, y) {
  const cx = Math.min(Math.max(x, RADIUS), S - RADIUS);
  const cy = Math.min(Math.max(y, RADIUS), S - RADIUS);
  const d = Math.hypot(x - cx, y - cy);
  return Math.min(Math.max(RADIUS - d + 0.5, 0), 1);
}

/** The glyph: a bar with rounded ends and two legs, the right one kicked out a little. */
function glyph(x, y) {
  const bar = y >= 36 && y <= 50 && x >= 30 && x <= 98;
  const barCapL = Math.hypot(x - 30, y - 43) <= 7;
  const barCapR = Math.hypot(x - 98, y - 43) <= 7;
  const drift = (y - 50) * 0.09; // the legs splay a little, the way the letter is drawn
  const legL = y > 50 && y <= 96 && x >= 41 - drift && x <= 55 - drift;
  const legR = y > 50 && y <= 96 && x >= 73 + drift && x <= 87 + drift;
  return bar || barCapL || barCapR || legL || legR ? 1 : 0;
}

for (let y = 0; y < S; y++) {
  const t = y / (S - 1);
  const bg = BG_TOP.map((c, i) => Math.round(c + (BG_BOTTOM[i] - c) * t));
  for (let x = 0; x < S; x++) {
    // 3x3 supersampling so both the tile edge and the glyph come out smooth.
    let a = 0;
    let on = 0;
    for (let sy = 0; sy < 3; sy++) {
      for (let sx = 0; sx < 3; sx++) {
        const px_ = x + (sx + 0.5) / 3;
        const py_ = y + (sy + 0.5) / 3;
        a += coverage(px_, py_);
        on += glyph(px_, py_);
      }
    }
    a /= 9;
    on /= 9;
    const rgb = bg.map((c, i) => Math.round(c + (INK[i] - c) * on));
    const o = (y * S + x) * 4;
    px[o] = rgb[0];
    px[o + 1] = rgb[1];
    px[o + 2] = rgb[2];
    px[o + 3] = Math.round(a * 255);
  }
}

const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter: none
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) >>> 0 : crc32(body));
  return Buffer.concat([len, body, crc]);
};

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // truecolour with alpha
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'resources', 'icon.png');
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
