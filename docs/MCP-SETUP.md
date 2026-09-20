# HHBA MCP · Shadow Mode

The first MCP release intentionally exposes only non-billable tools:

- `draft_human_capability_request`
- `get_human_capability_request`
- `get_human_capability_result`

It does **not** expose dispatch, candidate selection, scoring, approval-token issuance, or publishing. Those remain HHBA-controlled operations until the approval UX and authentication boundary are production-ready.

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
