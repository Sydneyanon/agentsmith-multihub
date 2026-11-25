export type RouteName = "home" | "projects" | "repository" | "hypotheses" | "evidence" | "activity" | "later";
export interface Route { name: RouteName; id?: string; sub?: string; query: Record<string, string>; hash: string }

const NAMES: Record<string, RouteName> = {
  "": "home", home: "home", projects: "projects", repository: "repository", hypotheses: "hypotheses", evidence: "evidence", activity: "activity",
  reviews: "later", findings: "later", knowledge: "later", system: "later",
};

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [pathPart = "", queryPart = ""] = raw.split("?", 2);
  const [first = "", id, sub] = pathPart.split("/").map(decodeURIComponent);
  const query: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(queryPart)) query[k] = v;
  const name = Object.prototype.hasOwnProperty.call(NAMES, first) ? NAMES[first]! : "home";
  const route: Route = { name, query, hash: `#/${raw}` };
  if (name === "later") route.sub = first;
  else {
    if (id) route.id = id;
    if (sub) route.sub = sub;
  }
  return route;
}

export const link = (...parts: string[]): string => `#/${parts.map(encodeURIComponent).join("/")}`;
export const linkWith = (path: string, query: Record<string, string | undefined>): string => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) qs.set(k, v);
  return qs.size ? `${path}?${qs}` : path;
};
