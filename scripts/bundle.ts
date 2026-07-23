import { bundle } from "https://deno.land/x/emit@0.40.0/mod.ts";
const result = await bundle(new URL("file://" + Deno.cwd() + "/scripts/embassy.ts"));
await Deno.writeTextFile("scripts/embassy.js", result.code);
