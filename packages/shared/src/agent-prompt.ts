import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mdPath = fileURLToPath(new URL("./agent-prompt.md", import.meta.url));

export const AUREX_AGENT_FILE = "AGENTS.md";

export const AUREX_AGENT_SYSTEM_PROMPT = readFileSync(mdPath, "utf8");
