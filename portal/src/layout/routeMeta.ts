export const ROUTE_LABELS: Record<string, string> = {
  reference: "API Reference",
  licensing: "Licensing",
  login: "Sign in",
  keys: "API keys",
  sandbox: "Playground",
};

/** Routes that are considered “console” / account-oriented (sidebar highlighting if extended). */
export const CONSOLE_TABS = new Set(["keys"]);
