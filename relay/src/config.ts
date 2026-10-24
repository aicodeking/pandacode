export const MIN_SECRET_CHARS = 32;

/** True when the Worker has what it needs; the caller answers a generic 500 otherwise and never says which secret. */
export const configured = (env: { SESSION_SECRET?: string; GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string }, forAuth: boolean): boolean =>
  typeof env.SESSION_SECRET === "string" && env.SESSION_SECRET.length >= MIN_SECRET_CHARS &&
  (!forAuth || (!!env.GITHUB_CLIENT_ID && !!env.GITHUB_CLIENT_SECRET));
