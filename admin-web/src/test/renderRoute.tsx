import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { AuthProvider, type AuthSnapshot } from "../app/providers/AuthProvider";
import { OrganizationProvider } from "../app/providers/OrganizationProvider";
import { appRoutes } from "../app/router";

export const defaultAdminSnapshot: AuthSnapshot = {
  session: {
    accessToken: "token",
    clientId: "client-1",
    expiresAt: "2099-01-01T00:00:00Z",
    user: { id: "user-1", email: "owner@example.com", name: "Owner" },
  },
  principal: { userId: "user-1", email: "owner@example.com", name: "Owner", clientId: "client-1" },
  organizations: [{ organizationId: "org-1", organizationName: "Acme", role: "owner" }],
};

export function renderAppRoute(path: string, snapshot: AuthSnapshot | null = defaultAdminSnapshot) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
  const initialSnapshot = snapshot ?? undefined;

  const view = render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider initialSnapshot={initialSnapshot}>
        <OrganizationProvider initialOrganizationId={initialSnapshot?.organizations[0]?.organizationId}>
          <RouterProvider router={router} />
        </OrganizationProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { ...view, router };
}
