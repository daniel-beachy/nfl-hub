// The few GitHub issue calls health.ts needs, behind an interface so tests use a fake.

export interface IssueRef {
  number: number;
  title: string;
  body: string;
}

export interface IssueClient {
  listOpen(label: string): Promise<IssueRef[]>;
  create(issue: { title: string; body: string; labels: string[] }): Promise<number>;
  updateBody(number: number, body: string): Promise<void>;
  closeWithComment(number: number, comment: string): Promise<void>;
}

/** REST client for one repository ("owner/name"), authenticated with an Actions or personal token. */
export function githubIssues(repository: string, token: string, doFetch: typeof fetch = fetch): IssueClient {
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await doFetch(`https://api.github.com/repos/${repository}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "nfl-hub-health",
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };
  return {
    async listOpen(label) {
      const items = (await call("GET", `/issues?state=open&per_page=100&labels=${encodeURIComponent(label)}`)) as Array<{
        number: number; title: string; body: string | null; pull_request?: unknown;
      }>;
      return items.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, body: i.body ?? "" }));
    },
    async create(issue) {
      return ((await call("POST", "/issues", issue)) as { number: number }).number;
    },
    async updateBody(number, body) {
      await call("PATCH", `/issues/${number}`, { body });
    },
    async closeWithComment(number, comment) {
      await call("POST", `/issues/${number}/comments`, { body: comment });
      await call("PATCH", `/issues/${number}`, { state: "closed", state_reason: "completed" });
    },
  };
}
