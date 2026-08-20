import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { useAuth } from "../providers/AuthProvider";
import { acceptInvitation } from "../../lib/api/invitations";
import { ApiError } from "../../lib/api/client";
import { AppShell } from "../../lib/ui/components/AppShell";
import { DataState } from "../../lib/ui/components/DataState";
import type { AcceptedInvitation } from "../../lib/api/types";

const ADMIN_ROLES = new Set(["owner", "admin"]);

interface AcceptError {
  title: string;
  description: string;
  action?: "retry" | "signout";
}

export function invitationRedirectQuery(token: string, email: string | null) {
  const params = new URLSearchParams({ invitation: token });
  if (email) {
    params.set("email", email);
  }
  return params.toString();
}

function mapAcceptError(caught: unknown, email: string | null): AcceptError {
  if (caught instanceof ApiError) {
    if (caught.status === 400 && caught.message === "invitation email does not match authenticated user") {
      return {
        title: "Signed in with a different address",
        description: `This invitation was sent to ${email ?? "a different address"}. Sign out and sign in with that address to accept it.`,
        action: "signout",
      };
    }
    if (caught.status === 400 && caught.message === "invitation is not pending") {
      return {
        title: "This invitation is no longer valid",
        description: "It was already accepted, cancelled, or it expired. Invitations are valid for 7 days — ask an organization admin to send a new one.",
      };
    }
    if (caught.status === 404) {
      return {
        title: "Invitation not found",
        description: "The link is incomplete or the invitation was removed. Check the link in your email or ask for a new invitation.",
      };
    }
  }

  return {
    title: "Could not accept the invitation",
    description: "Something went wrong accepting this invitation.",
    action: "retry",
  };
}

export function InvitationAcceptPage() {
  const { token = "" } = useParams<{ token: string }>();
  const [searchParams] = useSearchParams();
  const email = searchParams.get("email");
  const { status, session, refreshOrganizations, signOut } = useAuth();
  const [outcome, setOutcome] = useState<AcceptedInvitation | null>(null);
  const [error, setError] = useState<AcceptError | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const attempted = useRef(false);

  useEffect(() => {
    if (status !== "authenticated" || !session || attempted.current) {
      return;
    }
    attempted.current = true;

    acceptInvitation(session.accessToken, token)
      .then((accepted) => {
        setOutcome(accepted);
        return refreshOrganizations();
      })
      .catch((caught: unknown) => {
        setError(mapAcceptError(caught, email));
      });
  }, [status, session, token, email, refreshOrganizations, retryToken]);

  if (status === "loading") {
    return <DataState tone="neutral" title="Checking your session" description="Confirming whether you are signed in." />;
  }

  if (status === "anonymous") {
    return <Navigate replace to={`/login?${invitationRedirectQuery(token, email)}`} />;
  }

  if (status === "setupRequired") {
    return <Navigate replace to={`/register?${invitationRedirectQuery(token, email)}`} />;
  }

  const retry = () => {
    attempted.current = false;
    setError(null);
    setRetryToken((current) => current + 1);
  };

  return (
    <div className="ui-login-screen">
      <AppShell compact>
        <section className="ui-login-card">
          {outcome ? (
            <>
              <p className="ui-eyebrow">Invitation accepted</p>
              <h1 className="ui-page-title">
                You joined {outcome.organizationName} as {outcome.role}
              </h1>
              {ADMIN_ROLES.has(outcome.role) ? (
                <p className="ui-copy">
                  <Link to="/">Go to the admin console</Link>
                </p>
              ) : (
                <p className="ui-copy">Members work from the URLises browser extension. You can close this tab.</p>
              )}
            </>
          ) : error ? (
            <>
              <DataState tone="danger" title={error.title} description={error.description} />
              {error.action === "signout" ? (
                <button className="ui-button ui-button-primary" type="button" onClick={() => void signOut()}>
                  Sign out
                </button>
              ) : error.action === "retry" ? (
                <button className="ui-button ui-button-primary" type="button" onClick={retry}>
                  Try again
                </button>
              ) : null}
            </>
          ) : (
            <DataState tone="neutral" title="Accepting your invitation" description="Hold on while we add you to the organization." />
          )}
        </section>
      </AppShell>
    </div>
  );
}
