import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const GITHUB_API = "https://api.github.com";

async function gh(path, options = {}) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = text;
  }

  if (!res.ok) {
    const err = new Error(
      `GitHub API error ${res.status} on ${path}: ${
        typeof data === "string" ? data : JSON.stringify(data)
      }`
    );
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

async function assertOwnerMatchesToken(owner) {
  const me = await gh("/user");
  if (me.login.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(
      `Refusing to proceed: GITHUB_TOKEN authenticates as '${me.login}', but GITHUB_OWNER ` +
        `is set to '${owner}'. This mismatch would create/push content under the wrong ` +
        `account. Either set GITHUB_OWNER to '${me.login}', or generate a new token whose ` +
        `resource owner is '${owner}'.`
    );
  }
}

/** Resolves a branch ref, returning null on 404 rather than throwing. */
async function tryGetRef(owner, repo, branch) {
  try {
    return await gh(`/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  } catch (err) {
    if (err.status !== 404) throw err;
    return null;
  }
}

function getServer() {
  const server = new McpServer({
    name: "github-repo-assistant",
    version: "1.1.0",
  });

  server.tool(
    "create_repo",
    "Create a new GitHub repository under the configured owner if it doesn't already exist. " +
      "Returns the existing repo's info if it already exists, instead of erroring.",
    {
      name: z.string().describe("Repository name, e.g. 'my-new-project'"),
      description: z.string().optional().describe("Short repository description"),
      private: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether the repo should be private (default: false)"),
    },
    async ({ name, description, private: isPrivate }) => {
      const owner = process.env.GITHUB_OWNER;

      try {
        const existing = await gh(`/repos/${owner}/${name}`);
        return {
          content: [
            {
              type: "text",
              text: `Repo already exists: ${existing.html_url} (default branch: ${existing.default_branch})`,
            },
          ],
        };
      } catch (err) {
        if (err.status !== 404) throw err;
      }

      const created = await gh(`/user/repos`, {
        method: "POST",
        body: JSON.stringify({
          name,
          description,
          private: !!isPrivate,
          auto_init: true,
        }),
      });

      return {
        content: [
          {
            type: "text",
            text: `Created repo: ${created.html_url} (default branch: ${created.default_branch})`,
          },
        ],
      };
    }
  );

  server.tool(
    "create_branch",
    "Create a real branch from an existing base branch, so it starts with the full repo " +
      "history and file tree. Use this before pushing review branches. If the branch " +
      "already exists this reports its current SHA instead of erroring.",
    {
      repo: z.string().describe("Repository name (owner comes from server config)"),
      branch: z.string().describe("New branch name, e.g. 'feat/my-change'"),
      from: z
        .string()
        .optional()
        .describe("Base branch to branch from (default: the repo's default branch)"),
    },
    async ({ repo, branch, from }) => {
      const owner = process.env.GITHUB_OWNER;

      const existing = await tryGetRef(owner, repo, branch);
      if (existing) {
        return {
          content: [
            {
              type: "text",
              text: `Branch '${branch}' already exists at ${existing.object.sha.slice(0, 7)}. Nothing to do.`,
            },
          ],
        };
      }

      const repoInfo = await gh(`/repos/${owner}/${repo}`);
      const base = from || repoInfo.default_branch;

      const baseRef = await tryGetRef(owner, repo, base);
      if (!baseRef) {
        throw new Error(
          `Base branch '${base}' does not exist in ${owner}/${repo}, so there is nothing ` +
            `to branch from. Check the name, or push an initial commit first.`
        );
      }

      await gh(`/repos/${owner}/${repo}/git/refs`, {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseRef.object.sha }),
      });

      return {
        content: [
          {
            type: "text",
            text:
              `Created branch '${branch}' from '${base}' at ${baseRef.object.sha.slice(0, 7)}.\n` +
              `View: ${repoInfo.html_url}/tree/${branch}`,
          },
        ],
      };
    }
  );

  server.tool(
    "push_files",
    "Create or update one or more files in a GitHub repo in a single commit. " +
      "If the target branch doesn't exist, it is branched off base_branch (or the repo's " +
      "default branch) so it keeps the full history and file tree. Only a genuinely empty " +
      "repo produces a root commit.",
    {
      repo: z.string().describe("Repository name (owner comes from server config)"),
      branch: z
        .string()
        .optional()
        .default("main")
        .describe("Branch to push to (default: main)"),
      base_branch: z
        .string()
        .optional()
        .describe(
          "Only used when `branch` doesn't exist yet: which branch to create it from. " +
            "Defaults to the repo's default branch."
        ),
      commit_message: z.string().describe("Commit message for this push"),
      files: z
        .array(
          z.object({
            path: z.string().describe("File path within the repo, e.g. 'src/index.js'"),
            content: z.string().describe("Full text content of the file"),
          })
        )
        .min(1)
        .describe("Files to create or update in this commit"),
    },
    async ({ repo, branch, base_branch, commit_message, files }) => {
      const owner = process.env.GITHUB_OWNER;

      const ref = await tryGetRef(owner, repo, branch);

      let parentSha;
      let branchedFrom = null;

      if (ref) {
        parentSha = ref.object.sha;
      } else {
        // The branch is new. Previously this fell through with no parent and no
        // base_tree, producing an ORPHAN branch containing only the pushed files --
        // which then fails to build, since everything else in the repo is missing.
        // Inherit from a base branch instead, and only allow a root commit when the
        // repo genuinely has no commits at all.
        const repoInfo = await gh(`/repos/${owner}/${repo}`);
        const base = base_branch || repoInfo.default_branch;
        const baseRef = await tryGetRef(owner, repo, base);

        if (baseRef) {
          parentSha = baseRef.object.sha;
          branchedFrom = base;
        } else if (base_branch) {
          throw new Error(
            `base_branch '${base_branch}' does not exist in ${owner}/${repo}. Refusing to ` +
              `create an orphan branch, which would drop every other file in the repo.`
          );
        }
        // else: no default branch either -> empty repo -> root commit is correct
      }

      let baseTreeSha;
      if (parentSha) {
        const baseCommit = await gh(`/repos/${owner}/${repo}/git/commits/${parentSha}`);
        baseTreeSha = baseCommit.tree.sha;
      }

      const tree = await gh(`/repos/${owner}/${repo}/git/trees`, {
        method: "POST",
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree: files.map((f) => ({
            path: f.path,
            mode: "100644",
            type: "blob",
            content: f.content,
          })),
        }),
      });

      const commit = await gh(`/repos/${owner}/${repo}/git/commits`, {
        method: "POST",
        body: JSON.stringify({
          message: commit_message,
          tree: tree.sha,
          parents: parentSha ? [parentSha] : [],
        }),
      });

      if (ref) {
        await gh(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
          method: "PATCH",
          body: JSON.stringify({ sha: commit.sha }),
        });
      } else {
        await gh(`/repos/${owner}/${repo}/git/refs`, {
          method: "POST",
          body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
        });
      }

      const repoInfo = await gh(`/repos/${owner}/${repo}`);

      let note = "";
      if (branchedFrom) {
        note = `\nCreated branch '${branch}' from '${branchedFrom}'.`;
      } else if (!ref) {
        note = `\nRepo had no commits, so this is a root commit on '${branch}'.`;
      }

      return {
        content: [
          {
            type: "text",
            text:
              `Pushed ${files.length} file(s) to ${owner}/${repo}@${branch}.${note}\n` +
              `View: ${repoInfo.html_url}/tree/${branch}`,
          },
        ],
      };
    }
  );

  server.tool(
    "read_file",
    "Read the contents of a single file from a GitHub repo.",
    {
      repo: z.string().describe("Repository name (owner comes from server config)"),
      path: z.string().describe("File path within the repo, e.g. 'src/index.js'"),
      branch: z
        .string()
        .optional()
        .default("main")
        .describe("Branch to read from (default: main)"),
    },
    async ({ repo, path, branch }) => {
      const owner = process.env.GITHUB_OWNER;

      const data = await gh(
        `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`
      );

      if (Array.isArray(data)) {
        throw new Error(
          `'${path}' is a directory, not a file. Use list_directory instead.`
        );
      }

      if (data.type !== "file") {
        throw new Error(`'${path}' is not a regular file (type: ${data.type}).`);
      }

      if (data.size > 1_000_000) {
        throw new Error(
          `'${path}' is ${data.size} bytes, which exceeds the 1MB limit the Contents API ` +
            `supports for inline reads.`
        );
      }

      const decoded = Buffer.from(data.content, data.encoding || "base64").toString("utf-8");

      return {
        content: [
          {
            type: "text",
            text: decoded,
          },
        ],
      };
    }
  );

  server.tool(
    "list_directory",
    "List files and subdirectories at a given path in a GitHub repo (defaults to repo root).",
    {
      repo: z.string().describe("Repository name (owner comes from server config)"),
      path: z
        .string()
        .optional()
        .default("")
        .describe("Directory path within the repo (empty string for repo root)"),
      branch: z
        .string()
        .optional()
        .default("main")
        .describe("Branch to list from (default: main)"),
    },
    async ({ repo, path, branch }) => {
      const owner = process.env.GITHUB_OWNER;

      const data = await gh(
        `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`
      );

      if (!Array.isArray(data)) {
        throw new Error(`'${path || "/"}' is a file, not a directory. Use read_file instead.`);
      }

      const listing = data
        .map((item) => `${item.type === "dir" ? "[dir]  " : "[file] "}${item.path}`)
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: listing || "(empty directory)",
          },
        ],
      };
    }
  );

  return server;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed. This endpoint only accepts POST." });
    return;
  }

  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_OWNER) {
    res.status(500).json({
      error: "Server misconfigured: set GITHUB_TOKEN and GITHUB_OWNER environment variables.",
    });
    return;
  }

  const server = getServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
}
