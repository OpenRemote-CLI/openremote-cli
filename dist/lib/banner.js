import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export function printBanner() {
    const bannerPath = join(__dirname, "..", "..", "assets", "openremote.txt");
    try {
        const banner = readFileSync(bannerPath, "utf-8");
        // Normalize line endings and strip only leading/trailing blank lines,
        // preserving the leading spaces on each content line.
        const trimmedBanner = banner
            .replace(/\r\n/g, "\n")
            .replace(/^\n+/, "")
            .trimEnd();
        console.log(trimmedBanner);
        console.log(); // Add a single newline after the banner
    }
    catch {
        // Fallback if file is missing
        console.log("OpenRemote");
        console.log();
    }
}
//# sourceMappingURL=banner.js.map