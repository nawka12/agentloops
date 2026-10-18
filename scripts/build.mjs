// `prepack`: src/*.ts -> dist/*.js. Node refuses to type-strip files under node_modules, so the package ships plain JS.
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const src = new URL("../src/", import.meta.url), out = new URL("../dist/", import.meta.url);
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const f of readdirSync(src).filter((f) => f.endsWith(".ts"))) {
  // relative ".ts" specifiers in string literals (static/dynamic imports, new URL("./x.ts", import.meta.url)) become ".js"
  const js = stripTypeScriptTypes(readFileSync(new URL(f, src), "utf8"), { mode: "strip" }).replace(/(["'])(\.{1,2}\/[^"'\n]*)\.ts\1/g, "$1$2.js$1");
  const dest = new URL(f.replace(/\.ts$/, ".js"), out);
  writeFileSync(dest, js);
  if (js.startsWith("#!")) chmodSync(dest, 0o755);
}
