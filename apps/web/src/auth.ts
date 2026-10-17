const KEY = "heartwood.token";

/** The bearer token for the daemon, kept in this browser only. */
export const auth = {
  get(): string | undefined {
    try {
      return localStorage.getItem(KEY) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(token: string | undefined): void {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  },
};
