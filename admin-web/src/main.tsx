import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { AuthProvider } from "./app/providers/AuthProvider";
import { OrganizationProvider } from "./app/providers/OrganizationProvider";
import { createAppRouter } from "./app/router";
import { ErrorBoundary, installGlobalFailureReporting } from "./app/observability";
import { applyStoredColorScheme } from "./lib/ui/useColorScheme";
import "./lib/ui/tokens.css";

// Apply the stored/system color scheme before the first paint so anonymous
// screens (e.g. LoginPage, which has no theme toggle) never flash the wrong
// theme while AdminLayout's interactive useColorScheme() hasn't mounted yet.
applyStoredColorScheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const router = createAppRouter();
installGlobalFailureReporting();
window.addEventListener("admin-web:signout", () => queryClient.clear());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <OrganizationProvider>
            <RouterProvider router={router} />
          </OrganizationProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
