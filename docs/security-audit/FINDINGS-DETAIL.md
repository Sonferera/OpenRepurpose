# Findings detail

This file holds the full source path and target-neutral local reproduction for each **confirmed** `medium`, `high` or `critical` record.

## No confirmed records

This run produced **zero confirmed findings**, so there is no confirmed trace, reproduction, observed output, containment analysis or remediation to copy here.

Why nothing was confirmed, and what would change it:

- No OS-enforced sandbox (no empty-environment + no-external-network + read-only target + scratch-only write enforcement) is available on this Windows host, and the Python dependencies (fastapi, torch, rdkit, mcp) are not installed; installing them would require network access, which the audit forbids.
- A confirmed verdict requires a bounded observed local result at the boundary. Where the decisive fact was readable in source (for example that the credential branch in `api/server.py:187` covers only `/mcp` and `/mcp/*`), the source trace was still recorded, but the *effect* — an unauthenticated caller listing, minting or revoking a key, a browser origin reaching the loopback MCP endpoint, a route registered outside `/mcp` — needs an observed run against the bridge with its real dependency stack to be demonstrated.
- The six leads that remain are carried in `NEEDS-VALIDATION.md` with their exact blockers and resolution plans. They are not findings and carry no severity.
