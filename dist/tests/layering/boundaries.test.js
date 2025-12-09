import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_LAYERS = {
    shared: [],
    db: ["shared"],
    agents: ["shared", "db"],
    integrations: ["shared"],
    core: ["shared", "db", "agents", "integrations"],
    generators: ["shared", "core"],
    cli: ["shared", "core"],
};
const packagesToCheck = Object.keys(PACKAGE_LAYERS);
const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await walk(full)));
        }
        else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
            files.push(full);
        }
    }
    return files;
};
const findImports = (content) => {
    const imports = [];
    const pattern = /from\s+["']@mcoda\/([^"'/\s]+)[^"']*["']/g;
    let match;
    while ((match = pattern.exec(content)) !== null) {
        imports.push(match[1]);
    }
    return imports;
};
describe("layer boundaries (SDS 5.x)", () => {
    it("disallows downward/sideways imports between packages", async () => {
        const root = path.resolve(__dirname, "..", "..", "packages");
        const violations = [];
        for (const pkg of packagesToCheck) {
            const pkgSrc = path.join(root, pkg, "src");
            const files = await walk(pkgSrc);
            for (const file of files) {
                const content = await readFile(file, "utf8");
                const targets = findImports(content);
                for (const target of targets) {
                    if (target === pkg)
                        continue;
                    const allowed = PACKAGE_LAYERS[pkg] ?? [];
                    if (!allowed.includes(target)) {
                        const rel = path.relative(path.join(root, ".."), file);
                        violations.push(`${rel} imports @mcoda/${target}, but ${pkg} may depend on [${allowed.join(", ") || "none"}]`);
                    }
                }
            }
        }
        expect(violations).toEqual([]);
    });
});
