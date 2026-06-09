import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";
const [src, dst, x0, y0, w, h] = process.argv.slice(2);
const png = PNG.sync.read(readFileSync(src));
const out = new PNG({ width: Number(w), height: Number(h) });
PNG.bitblt(png, out, Number(x0), Number(y0), Number(w), Number(h), 0, 0);
writeFileSync(dst, PNG.sync.write(out));
