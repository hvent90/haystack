import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";
const [src, dst, x0, y0, w, h, gain] = process.argv.slice(2);
const png = PNG.sync.read(readFileSync(src));
const out = new PNG({ width: Number(w), height: Number(h) });
PNG.bitblt(png, out, Number(x0), Number(y0), Number(w), Number(h), 0, 0);
const g = Number(gain);
for (let i = 0; i < out.data.length; i += 4) {
  out.data[i] = Math.min(255, out.data[i] * g);
  out.data[i + 1] = Math.min(255, out.data[i + 1] * g);
  out.data[i + 2] = Math.min(255, out.data[i + 2] * g);
}
writeFileSync(dst, PNG.sync.write(out));
