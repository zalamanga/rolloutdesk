import { useEffect, useRef, useState, type FormEvent } from "react";
import { Api, ApiError } from "./api";
import type { Session } from "./types";
import { parseRoute, type Editor } from "./utils";
import { Message } from "./components";
import RegistryPage from "./RegistryPage";
import FlagPage from "./FlagPage";
import PlaygroundPage from "./PlaygroundPage";
import AuditPage from "./AuditPage";

export default function App() {
  const [api] = useState(() => new Api());
  const [session, setSession] = useState<Session | null>(null);
  const [booting, setBooting] = useState(true);
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  const [expired, setExpired] = useState(false);
  const [bootError, setBootError] = useState("");
  const editors = useRef(new Map<string, Editor>());
  const locks = useRef(new Set<string>());
  const [logoutError, setLogoutError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  api.onUnauthorized = () => {
    setSession(null);
    setExpired(true);
  };

  async function restore() {
    setBooting(true);
    setBootError("");
    try {
      const found = await api.request<Session>("/api/auth/session");
      api.csrfToken = found.csrfToken;
      setSession(found);
      setExpired(false);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setExpired(false);
      else setBootError((error as Error).message);
    } finally {
      setBooting(false);
    }
  }
  useEffect(() => {
    void restore();
  }, []);
  useEffect(() => {
    const change = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);

  async function logout() {
    if (signingOut) return;
    setSigningOut(true);
    setLogoutError("");
    try {
      await api.request("/api/auth/logout", "POST");
      api.csrfToken = "";
      setSession(null);
      setExpired(false);
    } catch (error) {
      setLogoutError((error as Error).message);
    } finally {
      setSigningOut(false);
    }
  }

  if (booting)
    return (
      <main className="boot" aria-live="polite">
        Reading your session…
      </main>
    );
  if (bootError)
    return (
      <main className="login">
        <h1>RolloutDesk</h1>
        <Message>{bootError}</Message>
        <button onClick={() => void restore()}>Retry session check</button>
      </main>
    );
  if (!session)
    return (
      <Login
        api={api}
        expired={expired}
        onLogin={(found) => {
          api.csrfToken = found.csrfToken;
          setSession(found);
          setExpired(false);
        }}
      />
    );

  const active = route.page === "detail" ? "flags" : route.page;
  return (
    <>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to workspace
      </a>
      <header className="topbar">
        <a href="#/flags" className="brand" aria-label="RolloutDesk flags">
          RolloutDesk<span>Release control lab</span>
        </a>
        <nav aria-label="Workspace">
          {[
            ["flags", "Flags"],
            ["playground", "Playground"],
            ["audit", "Audit"],
          ].map(([key, name]) => (
            <a
              key={key}
              href={`#/${key}`}
              aria-current={active === key ? "page" : undefined}
            >
              {name}
            </a>
          ))}
        </nav>
        <div className="account">
          <span>{session.user.email}</span>
          <button disabled={signingOut} onClick={() => void logout()}>
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="workspace">
        {logoutError && <Message>{logoutError}</Message>}
        {route.page === "flags" && <RegistryPage api={api} />}
        {route.page === "detail" && (
          <FlagPage
            key={`${route.key}/${route.environment}`}
            api={api}
            flagKey={route.key}
            environment={route.environment}
            editors={editors.current}
            locks={locks.current}
          />
        )}
        {route.page === "playground" && <PlaygroundPage api={api} />}
        {route.page === "audit" && <AuditPage api={api} />}
      </main>
      <footer className="footer">
        Local lab · Three registered demo flags · Client evaluation stores no
        subjects
      </footer>
    </>
  );
}

function Login({
  api,
  expired,
  onLogin,
}: {
  api: Api;
  expired: boolean;
  onLogin: (session: Session) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError("");
    try {
      onLogin(
        await api.request<Session>("/api/auth/login", "POST", {
          email,
          password,
        }),
      );
      setPassword("");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <main className="login-layout">
      <section className="login-intro">
        <p className="wordmark">RolloutDesk</p>
        <h1>
          Review a draft.
          <br />
          Publish a revision.
        </h1>
        <p>
          A local lab for deterministic feature flags. Compare staging and
          production, publish a saved draft, then trace every change in history.
        </p>
        <dl className="login-facts">
          <div>
            <dt>Draft</dt>
            <dd>Editable configuration</dd>
          </div>
          <div>
            <dt>Publication</dt>
            <dd>Immutable client behavior</dd>
          </div>
          <div>
            <dt>Rollback</dt>
            <dd>New revision, retained draft</dd>
          </div>
        </dl>
      </section>
      <section className="login-sheet">
        <h2>Sign in to RolloutDesk</h2>
        <p>Use the operator credentials generated on this computer.</p>
        {expired && (
          <Message tone="warning">
            Your session ended. Sign in again. Draft edits and notes stay in
            this tab; refresh the flag before another write.
          </Message>
        )}
        {error && <Message>{error}</Message>}
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button className="primary" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="small muted">
          The local setup stores credentials in{" "}
          <code>.local/LOCAL-CREDENTIALS.txt</code>. Keep that file private.
        </p>
      </section>
    </main>
  );
}
