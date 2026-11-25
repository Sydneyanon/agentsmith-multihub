import type { Api } from "./api.js";
export interface Ctx { api: Api; go: (hash: string) => void }
