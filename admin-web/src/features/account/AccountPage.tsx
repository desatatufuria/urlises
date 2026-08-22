import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "../../app/providers/AuthProvider";
import { ApiError } from "../../lib/api/client";
import { deactivateSelf } from "../../lib/api/auth";
import { ConfirmByTyping } from "../../lib/ui/components/ConfirmByTyping";
import { DataState } from "../../lib/ui/components/DataState";

const SOLE_OWNER_MESSAGE =
  "You're the sole owner of at least one organization — transfer ownership or leave it before deactivating your account.";

// Self-service account deactivation is a dedicated page rather than an
// inline action beside "Sign out" in AdminLayout — an irreversible action
// next to a same-shaped button is a misclick hazard, and a page gives room
// for the explanation the action needs.
export function AccountPage() {
  const { session, principal, signOut } = useAuth();
  const token = session?.accessToken;
  const [deactivateError, setDeactivateError] = useState<string | null>(null);

  const deactivateMutation = useMutation({
    mutationFn: () => deactivateSelf(token!),
    onSuccess: async () => {
      await signOut();
    },
    onError: (error) => {
      setDeactivateError(
        error instanceof ApiError && error.status === 409
          ? SOLE_OWNER_MESSAGE
          : error instanceof Error
            ? error.message
            : "The account could not be deactivated.",
      );
    },
  });

  return (
    <section className="ui-section-stack">
      <header className="ui-page-intro">
        <p className="ui-eyebrow">Account</p>
        <h1 className="ui-page-title">Your account</h1>
        <p className="ui-copy">Manage your own account. Deactivation is self-service only — no admin can trigger it on your behalf.</p>
      </header>
      <section className="ui-danger-zone">
        <p className="ui-eyebrow">Danger zone</p>
        <h2 className="ui-section-title">Deactivate my account</h2>
        <p className="ui-copy">
          This immediately signs you out everywhere and blocks future sign-in. It cannot be undone from this screen.
        </p>
        {deactivateError ? (
          <DataState tone="danger" compact title="Account deactivation failed" description={deactivateError} />
        ) : null}
        <ConfirmByTyping
          expected={principal?.email ?? ""}
          confirmLabel="Deactivate my account"
          disabled={deactivateMutation.isPending}
          onConfirm={() => {
            setDeactivateError(null);
            deactivateMutation.mutate();
          }}
        />
      </section>
    </section>
  );
}
