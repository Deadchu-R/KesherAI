#!/usr/bin/env node
// After SignPath signs the Windows installer: puts the signed file in place of the unsigned one
// and updates latest.yml (its sha512 and size), so updates check the file that is published.
// Usage: node scripts/signed-installer.mjs <electron-builder out folder> <folder with the signed installer>
import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";

const [out, signed] = process.argv.slice(2);
if (!out || !signed) throw new Error("Usage: signed-installer.mjs <out> <signed>");
const exe = (await readdir(signed, { recursive: true })).find((f) => /Setup.*\.exe$/i.test(f));
if (!exe) throw new Error(`No signed installer in ${signed}`);
const name = exe.split(/[\\/]/).pop();
const target = join(out, name);
await copyFile(join(signed, exe), target);
const buf = await readFile(target);
const sha512 = createHash("sha512").update(buf).digest("base64");
const { size } = await stat(target);
const feed = join(out, "latest.yml");
let yml = await readFile(feed, "utf8");
yml = yml.replace(/^(\s*sha512:\s*).*$/gm, `$1${sha512}`).replace(/^(\s*size:\s*).*$/gm, `$1${size}`);
await writeFile(feed, yml);
// The block map describes the unsigned file; without it updates download the whole installer.
await rm(join(out, `${name}.blockmap`), { force: true });
console.log(`${name}: signed, ${size} bytes`);
