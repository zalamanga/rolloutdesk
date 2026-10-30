import { useState, type FormEvent } from "react";
import { Api } from "./api";
import type { Decision, Environment, Preview } from "./types";
import { environments, flagKeys } from "./types";
import { Message, PageHeading } from "./components";
import { subjectError } from "./utils";

const reasons: Record<Decision["reason"], string> = {
  DISABLED: "The switch is disabled. The allowlist does not override it.",
  ALLOWLIST: "The exact subject ID is in this configuration’s allowlist.",
  ROLLOUT:
    "The stable subject bucket is below this configuration’s rollout threshold.",
  OUTSIDE_ROLLOUT:
    "The stable subject bucket is at or above this configuration’s rollout threshold.",
  UNPUBLISHED:
    "This environment has no active publication. Clients receive false.",
  FLAG_NOT_FOUND: "The flag key is not registered. Clients receive false.",
};

export default function PlaygroundPage({ api }: { api: Api }) {
  const [flagKey, setFlagKey] = useState<string>(flagKeys[0]);
  const [environment, setEnvironment] = useState<Environment>("staging");
  const [subject, setSubject] = useState("demo-subject-001");
  const [result, setResult] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [tested, setTested] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const validation = subjectError(subject);
    if (validation) {
      setError(validation);
      return;
    }
    setPending(true);
    setResult(null);
    try {
      setResult(
        await api.request<Preview>(
          `/api/flags/${flagKey}/${environment}/preview`,
          "POST",
          { subjectId: subject },
        ),
      );
      setTested(subject);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <PageHeading title="Evaluation playground">
        Compare the saved draft with the published revision using the server’s
        evaluation function.
      </PageHeading>
      <div className="playground-layout">
        <section className="sheet">
          <h2>Evaluate a synthetic subject</h2>
          <form onSubmit={(event) => void submit(event)} noValidate>
            <label htmlFor="preview-flag">Flag</label>
            <select
              id="preview-flag"
              value={flagKey}
              onChange={(event) => {
                setFlagKey(event.target.value);
                setResult(null);
              }}
              disabled={pending}
            >
              {flagKeys.map((key) => (
                <option key={key}>{key}</option>
              ))}
            </select>
            <label htmlFor="preview-environment">Environment</label>
            <select
              id="preview-environment"
              value={environment}
              onChange={(event) => {
                setEnvironment(event.target.value as Environment);
                setResult(null);
              }}
              disabled={pending}
            >
              {environments.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            <label htmlFor="preview-subject">Subject ID</label>
            <input
              id="preview-subject"
              value={subject}
              onChange={(event) => {
                setSubject(event.target.value);
                setResult(null);
              }}
              spellCheck={false}
              autoComplete="off"
              aria-describedby="subject-help"
              disabled={pending}
            />
            <p id="subject-help" className="field-help">
              Case sensitive. Use an invented identifier, 1 to 64 ASCII letters,
              digits, dots, underscores or hyphens.
            </p>
            <button className="primary" disabled={pending}>
              {pending ? "Evaluating…" : "Compare saved configurations"}
            </button>
          </form>
          <p className="small muted">
            Preview stores no subject or exposure record. This does not run a
            customer transaction.
          </p>
        </section>
        <section className="preview-output" aria-live="polite">
          <h2>Server decisions</h2>
          {error && <Message>{error}</Message>}
          {pending ? (
            <p>Reading published and saved draft configurations…</p>
          ) : result ? (
            <>
              <p className="tested-subject">
                Subject <code>{tested}</code> · {environment}
              </p>
              <div className="decision-pair">
                <DecisionPanel
                  title="Published behavior"
                  decision={result.published}
                />
                <DecisionPanel
                  title="Saved draft preview"
                  decision={result.draft}
                />
              </div>
              <details>
                <summary>Inspect server response JSON</summary>
                <pre>{JSON.stringify(result, null, 2)}</pre>
              </details>
            </>
          ) : (
            <div className="empty-state">
              Choose a flag, environment and subject, then compare. Unsaved form
              edits are not part of this preview.
            </div>
          )}
        </section>
      </div>
      <aside className="plain-note">
        <h2>One stable bucket per subject and environment</h2>
        <p>
          The server hashes the flag key, environment and exact subject ID into
          bucket 0 to 9999. The cohort stays stable when a revision or
          percentage changes. A 25% threshold includes buckets below 2500; it
          does not guarantee exactly 25% of a finite audience.
        </p>
        <p>
          This decision is feature configuration, not an authorization check.
        </p>
      </aside>
    </>
  );
}

function DecisionPanel({
  title,
  decision,
}: {
  title: string;
  decision: Decision;
}) {
  return (
    <section className="decision">
      <h3>{title}</h3>
      <p className={`decision-value ${decision.value ? "true" : "false"}`}>
        {String(decision.value)}
      </p>
      <p>
        <strong>{decision.reason}</strong>
      </p>
      <p>{reasons[decision.reason]}</p>
      <dl className="facts">
        <div>
          <dt>Revision</dt>
          <dd>{decision.revision ?? "None"}</dd>
        </div>
        <div>
          <dt>Stable bucket</dt>
          <dd>{decision.bucket ?? "Not computed"}</dd>
        </div>
      </dl>
    </section>
  );
}
