import { useEffect, useState } from "react";
import { Api } from "./api";
import type { Flag } from "./types";
import { environments } from "./types";
import { Message, PageHeading, StateSummary, Updated } from "./components";
import { sameConfig } from "./utils";

export default function RegistryPage({ api }: { api: Api }) {
  const [flags, setFlags] = useState<Flag[] | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [readAt, setReadAt] = useState<string | null>(null);
  async function load() {
    setPending(true);
    setError("");
    try {
      setFlags(await api.request<Flag[]>("/api/flags"));
      setReadAt(new Date().toISOString());
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPending(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
      <PageHeading
        title="Feature flags"
        actions={
          <button onClick={() => void load()} disabled={pending}>
            {pending ? "Refreshing…" : "Refresh flags"}
          </button>
        }
      >
        Three demo flags. Each environment has its own draft, active revision
        and history.
      </PageHeading>
      {error && <Message>{error}</Message>}
      <Updated at={readAt} />
      {!flags ? (
        pending ? (
          <p role="status">Loading flag registry…</p>
        ) : (
          <p>Flag data is unavailable. Use Refresh flags to try again.</p>
        )
      ) : flags.length === 0 ? (
        <div className="sheet">
          <h2>No registered flags</h2>
          <p>Restart the API to seed the three demo flags, then refresh.</p>
        </div>
      ) : (
        <div className="registry">
          <div className="registry-heading">
            <span>Registered flag</span>
            <span>Staging</span>
            <span>Production</span>
          </div>
          {flags.map((flag) => (
            <article className="flag-row" key={flag.key}>
              <div className="flag-info">
                <h2>{flag.name}</h2>
                <code>{flag.key}</code>
                <p>{flag.description}</p>
              </div>
              {environments.map((environment) => {
                const state = flag.states.find(
                  (item) => item.environment === environment,
                )!;
                const changed =
                  !state.active ||
                  !sameConfig(state.draft, state.active.config);
                return (
                  <section
                    className="environment-cell"
                    key={environment}
                    aria-label={`${flag.key} ${environment}`}
                  >
                    <h3>{environment}</h3>
                    <StateSummary state={state} />
                    <span className="draft-hint">
                      {!state.active
                        ? "Draft awaiting first publication"
                        : changed
                          ? "Draft differs from active"
                          : "Draft matches active"}
                    </span>
                    <a
                      className="button-link"
                      href={`#/flags/${flag.key}/${environment}`}
                    >
                      Review {environment}
                    </a>
                  </section>
                );
              })}
            </article>
          ))}
        </div>
      )}
      <aside className="plain-note">
        <h2>Editing and publishing are separate</h2>
        <p>
          Saving a draft changes the workspace only. Clients use the active
          publication. An unpublished flag evaluates to false.
        </p>
      </aside>
    </>
  );
}
