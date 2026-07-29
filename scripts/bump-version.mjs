/* global console */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const pkgPath = path.join(rootDir, "package.json");

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const currentVersion = pkg.version || "0.1.0";

// 语义化版本号递增 patch：0.1.1 -> 0.1.2
const parts = currentVersion.split(".").map((part) => parseInt(part, 10));
if (parts.length < 3) {
  parts.push(0, 0, 0);
}
parts[2] += 1;
const newVersion = parts.slice(0, 3).join(".");

pkg.version = newVersion;
if (pkg.config && typeof pkg.config === "object") {
  pkg.config.version = newVersion;
}

fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`[bump-version] ${currentVersion} -> ${newVersion}`);
