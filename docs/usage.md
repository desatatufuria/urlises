# Usage Guide

## First run

1. Start Compose and open the reported admin-web port.
2. On an empty database, register the first account.
3. Create the first organization; the creator becomes owner.
4. Create a workspace; only the creator receives initial `admin` access.
5. Invite members or create groups, then configure direct or group workspace grants.
6. Build/load the extension, sign in, and select workspaces.

If account creation succeeds but organization creation is interrupted, sign in again to resume setup.

## URLises Control

The admin application manages control-plane state, not bookmark content.

| Route | Use |
| --- | --- |
| `/members` | Review members and pending invitations |
| `/groups` | Create flat groups and manage members |
| `/workspaces` | Create workspaces and review effective roles |
| `/access` | Grant/revoke direct user and group workspace access |

The access screen displays grant sources and the resolved highest role.

## Chrome extension

1. Open the popup and authenticate.
2. Open Options and choose workspaces.
3. The service worker creates/uses `URLises / Organization / Workspace` and hydrates it from the backend tree.
4. Local edits under the managed path are sent to the API when the role allows them.
5. Remote edits arrive through WebSocket; replay catches up events missed while the service worker was inactive.
6. Use **Resync all selected workspaces** when diagnostics report an unrecoverable condition.

The extension never synchronizes the entire personal Chrome bookmark tree.

## Roles

| Role | Canonical shared data | Local presentation |
| --- | --- | --- |
| `admin` | Read and mutate | Local controls allowed |
| `editor` | Read and mutate | Local controls allowed |
| `viewer` | Read only | Hide/exclude or reorder locally |

Viewer-local exclusions remain in `chrome.storage.local` and do not affect other users. Renaming, moving, changing a URL, or deleting shared content is canonical and is rejected or reverted for viewers.

## CLI workflow

```bash
node scripts/remote-bookmarks.mjs register \
  --backend-url http://localhost:8081 \
  --email admin@example.com --password secret123 \
  --name Admin --client-id local-cli

node scripts/remote-bookmarks.mjs get-tree \
  --backend-url http://localhost:8081 \
  --workspace-id <workspace-id> \
  --session-file /tmp/shared-bookmark-sync-session.json
```

Supported command families include `register`, `login`, `create-folder`, `create-bookmark`, `get-tree`, `replay`, and `listen-ws`. Run `node scripts/remote-bookmarks.mjs help` for flags.

Use `scripts/seed-demo.sh` for a local fixture. `scripts/activate-local-invitation.sh <email>` is a development helper requiring `jq`; it prompts for a password and never stores or prints it.

Invitation creation and local mail infrastructure exist, but invitation email delivery and acceptance are not yet a complete production workflow.

## Health checks

```bash
curl http://localhost:8081/healthz
curl http://localhost:8081/readyz
```

`/healthz` is liveness. `/readyz` requires a successful PostgreSQL ping.
