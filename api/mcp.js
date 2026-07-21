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

function getServer() {
  const server = new McpServer({
    name: "github-repo-assistant",
    version: "1.0.0",
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
    "push_files",
    "Create or update one or more files in a GitHub repo in a single commit. " +
      "Creates the branch if it doesn't exist yet (e.g. for a brand new empty repo).",
    {
      repo: z.string().describe("Repository name (owner comes from server config)"),
      branch: z
        .string()
        .optional()
        .default("main")
        .describe("Branch to push to (default: main)"),
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
    async ({ repo, branch, commit_message, files }) => {
      const owner = process.env.GITHUB_OWNER;

      let ref = null;
      try {
        ref = await gh(`/repos/${owner}/${repo}/git/ref/heads/${branch}`);
      } catch (err) {
        if (err.status !== 404) throw err;
      }

      let baseTreeSha;
      let parentSha;

      if (ref) {
        parentSha = ref.object.sha;
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

      return {
        content: [
          {
            type: "text",
            text: `Pushed ${files.length} file(s) to ${owner}/${repo}@${branch}.\nView: ${repoInfo.html_url}/tree/${branch}`,
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
