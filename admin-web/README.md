# Admin Web Operator UI

Minimal admin shell for OdA organization operators, now including the final PR 4 workspace and access slice.

## Quick path

1. From the repository root, run `docker compose up --build`.
2. Run `docker compose port admin-web 80` and open the reported loopback address; Nginx proxies `/api` to the Compose backend.
3. For local Vite development, install dependencies with `npm install` and run `VITE_API_BASE_URL=/api npm run dev`.
4. Vite proxies `/api` to `http://shared-bookmark-sync-backend:8080` by default. When running elsewhere, override it with `VITE_API_PROXY_TARGET=http://...`.
5. Use the Members, Invitations, Groups, Workspaces, and Access routes to validate the current operator surface.

On a fresh database, Admin Web redirects to first-run setup. The operator supplies the initial account credentials and organization name; that account becomes owner. Setup closes after the first organization exists. If account creation succeeds but organization creation is interrupted, sign in with that account to resume the organization step.

## Details

| Area | Decision |
|---|---|
| App shell | React Router guarded shell with Members, Invitations, Groups, Workspaces, and Access only |
| State | TanStack Query for server state, React context for session and active organization |
| API | Typed fetch client with auth token, stable client-id header, and normalization for invitation/group payloads plus workspace access snapshots |
| UI | Small premium/minimal token system with reusable shell, table, badge, data-state, and split-panel patterns |
| Feature scope | Members, Invitations, Groups, Workspaces, and Access routes only — bookmark content editing stays out of scope |

## Checklist

- [x] Login bootstrap and session restore exist.
- [x] Organization selection is persisted separately from auth.
- [x] Members and Invitations routes show live member/pending-invite workflows.
- [x] Groups route supports flat CRUD and group member assignment.
- [x] Workspaces route supports workspace creation plus effective-role inventory review.
- [x] Access route supports direct/group grants plus highest-role-wins review.

## Verification

```bash
npm run typecheck
npm run test
npm run build
```

## Manual validation checklist

- [ ] Login succeeds and the admin shell opens.
- [ ] Non-admin users are blocked from admin routes.
- [ ] Members/Invitations still show live people state.
- [ ] Groups still support member assignment.
- [ ] Workspaces can be created from the UI.
- [ ] Access shows direct + group grant sources and the effective highest role.

## Next step

Run the browser-based manual checklist above against the target backend before archiving the `admin-web-ui` change.
