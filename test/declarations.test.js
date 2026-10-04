/**
 * Smoke test: the shipped type surface stays complete.
 *
 * The package publishes `dist/*.d.ts` (tsc output of the JSDoc sources) and
 * points `types`/`exports` at `dist/index.d.ts`. If a new export is added to
 * `src/index.js` but the declaration pipeline breaks (or a re-exported module
 * stops emitting a sibling declaration), consumers fall back to inference or
 * fail to resolve types entirely. This test catches both.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);

/** Export names declared by the public entry, parsed from its re-export lines. */
function entryExportNames() {
  const source = readFileSync(path.join(root, "src", "index.js"), "utf8");
  const names = [];
  for (const match of source.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const piece of match[1].split(",")) {
      const name = piece
        .trim()
        .split(/\s+as\s+/)
        .pop()
        .trim();
      if (name) names.push(name);
    }
  }
  assert.ok(names.length > 0, "entry declares no exports");
  return names.sort();
}

test("tsc emits a declaration for every public export", {
  timeout: 30000,
}, () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "y-reticulum-dts-"));
  try {
    const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
    execFileSync(
      process.execPath,
      [tsc, "-p", path.join(root, "tsconfig.json"), "--outDir", outDir],
      {
        cwd: root,
        stdio: "pipe",
      },
    );

    const indexDts = readFileSync(path.join(outDir, "index.d.ts"), "utf8");
    const declared = new Set(
      [...indexDts.matchAll(/export\s*\{([^}]+)\}/g)].flatMap((match) =>
        match[1].split(",").map((piece) =>
          piece
            .trim()
            .split(/\s+as\s+/)
            .pop()
            .trim(),
        ),
      ),
    );
    for (const name of entryExportNames()) {
      assert.ok(declared.has(name), `dist/index.d.ts does not declare ${name}`);
    }

    // Every re-export target must have a sibling declaration, or the entry
    // types do not resolve for consumers.
    for (const match of indexDts.matchAll(/from\s*"(\.\/[^"]+)"/g)) {
      const target = path.join(outDir, match[1].replace(/\.js$/, ".d.ts"));
      assert.ok(
        readFileSync(target, "utf8").length > 0,
        `missing sibling declaration for ${match[1]}`,
      );
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
