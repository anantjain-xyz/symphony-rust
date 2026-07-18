import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DIST_DIR = resolve(SCRIPT_DIR, "../dist");
export const MANIFEST_PATH = resolve(DIST_DIR, ".vite/manifest.json");

export const BUDGETS = {
  eagerJavaScript: 80_500,
  eagerCss: 7_000,
  lazyViewJavaScript: 50_000,
};

export const LAZY_ENTRIES = [
  "src/views/RunsView.tsx",
  "src/views/IssuesView.tsx",
  "src/views/DependencyGraphPanel.tsx",
  "src/views/RetroView.tsx",
  "src/views/SettingsView.tsx",
];

export const FORBIDDEN_EAGER_ENTRIES = [
  "src/preview/runtime.ts",
  "src/AppUpdate.tsx",
];

export function collectStaticGraph(manifest, entryKey) {
  const visited = new Set();
  const visit = (key) => {
    if (visited.has(key)) return;
    const chunk = manifest[key];
    if (!chunk) throw new Error(`Manifest references missing chunk: ${key}`);
    visited.add(key);
    for (const imported of chunk.imports ?? []) visit(imported);
  };
  visit(entryKey);
  return visited;
}

export function collectJavaScriptFiles(manifest, graph, excludedGraph = new Set()) {
  const files = new Set();
  for (const key of graph) {
    if (excludedGraph.has(key)) continue;
    const file = manifest[key]?.file;
    if (file?.endsWith(".js")) files.add(file);
  }
  return files;
}

async function compressedSize(relativePath) {
  const bytes = await readFile(resolve(DIST_DIR, relativePath));
  return { raw: bytes.byteLength, gzip: gzipSync(bytes).byteLength };
}

function formatSize(bytes) {
  return `${(bytes / 1_000).toFixed(2)} kB`;
}

export async function inspectBundle() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const entryKey = Object.keys(manifest).find((key) => manifest[key].isEntry);
  if (!entryKey) throw new Error("Vite manifest has no eager entry");
  const eagerGraph = collectStaticGraph(manifest, entryKey);
  const eagerFiles = collectJavaScriptFiles(manifest, eagerGraph);
  const eagerCssFiles = new Set();
  for (const key of eagerGraph) {
    const chunk = manifest[key];
    for (const css of chunk.css ?? []) eagerCssFiles.add(css);
  }

  const sumFiles = async (files) => {
    const sizes = await Promise.all([...files].map(compressedSize));
    return sizes.reduce(
      (total, size) => ({ raw: total.raw + size.raw, gzip: total.gzip + size.gzip }),
      { raw: 0, gzip: 0 },
    );
  };

  const eagerJavaScript = await sumFiles(eagerFiles);
  const eagerCss = await sumFiles(eagerCssFiles);
  const lazyViews = Object.fromEntries(
    await Promise.all(
      LAZY_ENTRIES.map(async (key) => {
        const chunk = manifest[key];
        if (!chunk?.isDynamicEntry) throw new Error(`${key} is not a dynamic entry`);
        const graph = collectStaticGraph(manifest, key);
        const files = collectJavaScriptFiles(manifest, graph, eagerGraph);
        return [key, { ...(await sumFiles(files)), files: [...files].sort() }];
      }),
    ),
  );
  return { manifest, entryKey, eagerGraph, eagerJavaScript, eagerCss, lazyViews };
}

export async function checkBundleBudgets() {
  const result = await inspectBundle();
  const failures = [];
  if (result.eagerJavaScript.gzip > BUDGETS.eagerJavaScript) {
    failures.push(
      `eager JavaScript ${formatSize(result.eagerJavaScript.gzip)} exceeds ${formatSize(BUDGETS.eagerJavaScript)}`,
    );
  }
  if (result.eagerCss.gzip > BUDGETS.eagerCss) {
    failures.push(
      `eager CSS ${formatSize(result.eagerCss.gzip)} exceeds ${formatSize(BUDGETS.eagerCss)}`,
    );
  }
  for (const [key, size] of Object.entries(result.lazyViews)) {
    if (size.gzip > BUDGETS.lazyViewJavaScript) {
      failures.push(
        `${key} ${formatSize(size.gzip)} exceeds ${formatSize(BUDGETS.lazyViewJavaScript)}`,
      );
    }
  }
  for (const forbidden of FORBIDDEN_EAGER_ENTRIES) {
    if (result.eagerGraph.has(forbidden)) {
      failures.push(`${forbidden} appears in the eager static import graph`);
    }
  }

  console.log(
    `eager JavaScript: ${formatSize(result.eagerJavaScript.raw)} raw / ${formatSize(result.eagerJavaScript.gzip)} gzip`,
  );
  console.log(
    `eager CSS: ${formatSize(result.eagerCss.raw)} raw / ${formatSize(result.eagerCss.gzip)} gzip`,
  );
  for (const [key, size] of Object.entries(result.lazyViews)) {
    console.log(`${key}: ${formatSize(size.raw)} raw / ${formatSize(size.gzip)} gzip`);
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
  console.log("Bundle budgets passed.");
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkBundleBudgets();
}
