/** The bearer token lives in sessionStorage only: tab-scoped, never in a URL, cleared on lock. */
const KEY = "agentsmith.hub.token";
export function getToken(): string | null { try { return sessionStorage.getItem(KEY); } catch { return null; } }
export function setToken(token: string): void { try { sessionStorage.setItem(KEY, token); } catch { /* storage unavailable: the token is kept in memory by the caller */ } }
export function clearToken(): void { try { sessionStorage.removeItem(KEY); } catch { /* nothing to clear */ } }
