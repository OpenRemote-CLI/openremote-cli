import { createRequire } from "module";
import { fileURLToPath } from "url";
import { resolve, dirname } from "path";

const _require = createRequire(import.meta.url);
const _pkg = _require(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../package.json"),
) as { version: string };

export const CLI_VERSION: string = _pkg.version;
