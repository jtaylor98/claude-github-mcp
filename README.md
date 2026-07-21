# GitHub Repo Assistant (MCP server)

An MCP server with two tools:

- **create_repo** — creates a GitHub repo under a fixed owner if it doesn't already exist
- **push_files** — creates/updates one or more files in a single commit (creates the branch if needed)

Designed to run as a Vercel serverless function so Claude can call it as a remote MCP connector.

## 1. Push this code to GitHub

```bash
cd github-repo-assistant-mcp
git init
git add .
git commit -m "Initial commit: github repo assistant MCP server"
git branch -M main
git remote add origin https://github.com/<your-username>/github-repo-assistant-mcp.git
git push -u origin main
```

## 2. Deploy to Vercel

1. Go to https://vercel.com/new and import the GitHub repo you just pushed.
2. Leave build settings as default (no build step needed — it's a single API route).
3. Before deploying (or right after, then redeploy), add these **Environment Variables** in the Vercel project settings:

   | Name | Value |
   |---|---|
   | `GITHUB_TOKEN` | A GitHub Personal Access Token with `repo` scope (fine-grained: Contents + Administration read/write) |
   | `GITHUB_OWNER` | Your GitHub username or org name — the account repos will be created under |

4. Deploy. Your MCP endpoint will be:
   ```
   https://<your-project-name>.vercel.app/api/mcp
   ```

## 3. Connect it to Claude

Add it as a custom connector using that URL. Once connected, you can ask Claude things like:

> "Create a repo called `weekend-project` and push a basic Express server to it."

Claude will call `create_repo` then `push_files` against your GitHub account.

## Creating a GitHub token

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. Repository access: "All repositories" (or select ones, but then new repos can't be created into arbitrary names — "All repositories" is simpler for this use case)
3. Permissions needed: **Contents: Read and write**, **Administration: Read and write** (Administration is required to create new repos)

## Notes

- This server is stateless — each tool call is an independent request to the GitHub REST/Git Data API, which fits Vercel's serverless model well.
- `push_files` uses the Git Data API (trees/commits/refs) so multiple files land in a single commit rather than one API call per file.
- All repos are created under the single `GITHUB_OWNER` configured via environment variable. If you want Claude to create repos under different owners/orgs per request, add an optional `owner` parameter to the tools and pass it through instead of reading from `process.env`.
