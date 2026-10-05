import type { AdapterBase } from "./types";

const adapters: AdapterBase[] = [];

export function registerAdapter(a: AdapterBase): void {
  if (!adapters.some((x) => x.id === a.id)) adapters.push(a);
}

export function allAdapters(): AdapterBase[] {
  return [...adapters];
}
