import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { renderAsync } from '@resvg/resvg-js';
import { SVG_LIMITS, WIDGET_FONT } from './serialize.ts';
import { WIDGET_TOKENS, type WidgetTheme } from './render.ts';

export const MAX_RASTER_PX = 2048;

const FACES = ['Regular', 'Medium', 'Bold'];
let fontFiles: string[] | null = null;

/**
 * The widget font as TrueType files resvg can load (the Node binding takes
 * only file paths). Roboto (Apache-2.0) ships as WOFF in `roboto-fontface`,
 * which the page loads too, so the server and the page draw with the same
 * face. WOFF 1.0 is the sfnt tables, each zlib-compressed; this unpacks them
 * once per process into a private directory of its own (mkdtemp: unique
 * name, owner-only), created afresh and removed at exit.
 */
function widgetFontFiles(): string[] {
  if (fontFiles) return fontFiles;
  const require = createRequire(import.meta.url);
  const dir = mkdtempSync(join(tmpdir(), 'primer-widget-fonts-'));
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  fontFiles = FACES.map((face) => {
    const out = join(dir, `${WIDGET_FONT}-${face}.ttf`);
    const woff = readFileSync(require.resolve(`roboto-fontface/fonts/roboto/${WIDGET_FONT}-${face}.woff`));
    writeFileSync(out, woffToSfnt(woff), { flag: 'wx', mode: 0o600 });
    return out;
  });
  return fontFiles;
}

/** Decodes a WOFF 1.0 file to the sfnt (TrueType/OpenType) it wraps. */
export function woffToSfnt(woff: Buffer): Buffer {
  if (woff.toString('latin1', 0, 4) !== 'wOFF') throw new Error('not a WOFF 1.0 font');
  const flavor = woff.readUInt32BE(4);
  const numTables = woff.readUInt16BE(12);
  const tables = Array.from({ length: numTables }, (_, i) => {
    const at = 44 + i * 20;
    const offset = woff.readUInt32BE(at + 4);
    const compLength = woff.readUInt32BE(at + 8);
    const origLength = woff.readUInt32BE(at + 12);
    const raw = woff.subarray(offset, offset + compLength);
    return {
      tag: woff.subarray(at, at + 4),
      checksum: woff.readUInt32BE(at + 16),
      data: compLength < origLength ? inflateSync(raw) : raw,
    };
  });
  const entrySelector = Math.floor(Math.log2(numTables));
  const searchRange = 2 ** entrySelector * 16;
  const header = Buffer.alloc(12 + numTables * 16);
  header.writeUInt32BE(flavor, 0);
  header.writeUInt16BE(numTables, 4);
  header.writeUInt16BE(searchRange, 6);
  header.writeUInt16BE(entrySelector, 8);
  header.writeUInt16BE(numTables * 16 - searchRange, 10);
  const chunks: Buffer[] = [header];
  let offset = header.length;
  tables.forEach((table, i) => {
    const at = 12 + i * 16;
    table.tag.copy(header, at);
    header.writeUInt32BE(table.checksum, at + 4);
    header.writeUInt32BE(offset, at + 8);
    header.writeUInt32BE(table.data.length, at + 12);
    const padded = Buffer.alloc((table.data.length + 3) & ~3);
    table.data.copy(padded);
    chunks.push(padded);
    offset += padded.length;
  });
  return Buffer.concat(chunks);
}

/**
 * A PNG of a serialized widget SVG on the theme's surface: 1× its viewBox, at
 * most 2048 px on the long side. Only SVGs that passed `serializeSvg` (and so
 * its node and size bounds) come here.
 */
export async function rasterise(svg: string, theme: WidgetTheme): Promise<Buffer> {
  if (Buffer.byteLength(svg) > SVG_LIMITS.bytes) throw new Error('widget SVG over the size bound');
  const [, , width, height] = /viewBox="([^"]+)"/.exec(svg)![1]!.trim().split(/[\s,]+/).map(Number) as number[];
  const long = Math.max(width!, height!);
  const fitTo = width! >= height!
    ? { mode: 'width' as const, value: Math.round(Math.min(width!, (MAX_RASTER_PX * width!) / long)) }
    : { mode: 'height' as const, value: Math.round(Math.min(height!, (MAX_RASTER_PX * height!) / long)) };
  const image = await renderAsync(svg, {
    fitTo,
    background: WIDGET_TOKENS[theme].surface,
    font: { loadSystemFonts: false, fontFiles: widgetFontFiles(), defaultFontFamily: WIDGET_FONT, sansSerifFamily: WIDGET_FONT },
  });
  return image.asPng();
}
