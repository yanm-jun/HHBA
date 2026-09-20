# HHBA MCP · Shadow Mode

The first MCP release intentionally exposes only non-billable tools:

- `draft_human_capability_request`
- `get_human_capability_request`
- `get_human_capability_result`

It does **not** expose dispatch, candidate selection, scoring, approval-token issuance, or publishing. A draft response may include an HHBA browser confirmation URL. The URL only opens a review screen: an HttpOnly browser-bound confirmation session plus a user's explicit consent is required before the API issues a one-time publish token.

This is a local prototype boundary, not production authentication. Before a live launch, bind the confirmation session to an authenticated HHBA account, persist audited approvals, and add CSRF/origin protections appropriate to the deployed domain.

## Local Codex configuration

Start the HHBA API first:

```powershell
npm run api
```

Then add this project-local entry to `.codex/config.toml` in a trusted project:

```toml
[mcp_servers.hhba]
command = "node"
args = ["mcp-server.mjs"]
cwd = "C:\\path\\to\\hhba"
startup_timeout_sec = 20
tool_timeout_sec = 30
default_tools_approval_mode = "prompt"
```

Or add it through the Codex CLI:

```powershell
codex mcp add hhba -- node C:\path\to\hhba\mcp-server.mjs
```

The MCP initialization instructions tell the agent to use normal digital tools first, identify a Human Gap, create only a draft, and never publish work or spend money without a separate HHBA-controlled approval flow.
