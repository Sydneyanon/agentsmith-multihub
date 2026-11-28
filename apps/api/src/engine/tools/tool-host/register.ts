import { registerToolHost } from "../run-tool.js";
import { execFixed } from "./exec.js";

/** Importing this module enables tool execution in this process. Only non-production entry points import it (see run-tool.ts). */
registerToolHost({ execFixed });
