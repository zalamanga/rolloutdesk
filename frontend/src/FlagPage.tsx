import { useEffect, useState, type FormEvent } from "react";
import { Api, requiresReconciliation } from "./api";
import type { Environment, EnvironmentState, FlagDetail } from "./types";
import { ConfigSummary, Message, PageHeading, Updated } from "./components";
import {
  displayTime,
  editorConfig,
  newEditor,
  noteError,
  sameConfig,
  type Editor,
} from "./utils";

export default function FlagPage({
  api,
  flagKey,
  environment,
  editors,
  locks,
}: {
  api: Api;
  flagKey: string;
  environment: Environment;
  editors: Map<string, Editor>;
  locks: Set<string>;
}) {
  const identity = `${flagKey}/${environment}`;
  const [data, setData] = useState<FlagDetail | null>(null);
  const [editor, setEditor] = useState<Editor | null>(
    () => editors.get(identity) || null,
  );
  const [locked, setLocked] = useState(() => locks.has(identity));
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [readAt, setReadAt] = useState<string | null>(null);

  function update(patch: Partial<Editor>) {
    setEditor((previous) => {
      const value = { ...previous!, ...patch };
      editors.set(identity, value);
      return value;
    });
  }
  function adopt(found: FlagDetail) {
    setData(found);
    setReadAt(new Date().toISOString());
    if (!editors.has(identity)) {
      const value = newEditor(found.state.draft);
      editors.set(identity, value);
      setEditor(value);
    }
  }
  async function read(explicit = false) {
    setReading(true);
    setError("");
    try {
      adopt(
        await api.request<FlagDetail>(`/api/flags/${flagKey}/${environment}`),
      );
      if (explicit) {
        locks.delete(identity);
        setLocked(false);
        setNotice(
          "Current server state loaded. Your edited configuration and notes were retained. Review the version before writing again.",
        );
      }
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setReading(false);
    }
  }
  useEffect(() => {
    void read();
  }, []);

  async function mutate(kind: "draft" | "publish" | "rollback") {
    if (!data || !editor || busy || reading || locked) return;
    setError("");
    setNotice("");
    let body: unknown;
    try {
      if (kind === "draft")
        body = {
          expectedVersion: data.state.version,
          config: editorConfig(editor),
        };
      else {
        const note =
          kind === "publish" ? editor.publishNote : editor.rollbackNote;
        const validation = noteError(note);
        if (validation) throw new Error(validation);
        if (kind === "rollback" && !editor.targetRevision)
          throw new Error("Select a historical revision to copy.");
        body = {
          expectedVersion: data.state.version,
          note: note.trim(),
          ...(kind === "rollback"
            ? { targetRevision: Number(editor.targetRevision) }
            : {}),
        };
      }
    } catch (failure) {
      setError((failure as Error).message);
      return;
    }
    setBusy(true);
    try {
      if (kind === "draft") {
        const state = await api.request<EnvironmentState>(
          `/api/flags/${flagKey}/${environment}/draft`,
          "PUT",
          body,
        );
        setData({ ...data, state });
        setReadAt(new Date().toISOString());
        setNotice(
          "Draft saved. Client behavior is unchanged until you publish.",
        );
      } else {
        adopt(
          await api.request<FlagDetail>(
            `/api/flags/${flagKey}/${environment}/${kind}`,
            "POST",
            body,
          ),
        );
        setNotice(
          kind === "publish"
            ? "Saved draft published as a new active revision."
            : "Rollback published as a new revision. Your draft and edited form were retained.",
        );
      }
    } catch (failure) {
      setError((failure as Error).message);
      if (requiresReconciliation(failure)) {
        locks.add(identity);
        setLocked(true);
      }
    } finally {
      setBusy(false);
    }
  }

  let validation = "";
  let dirty = false;
  if (editor && data) {
    try {
      dirty = !sameConfig(editorConfig(editor), data.state.draft);
    } catch (failure) {
      validation = (failure as Error).message;
      dirty = true;
    }
  }
  const noPublicationChange =
    data?.state.active &&
    sameConfig(data.state.draft, data.state.active.config);
  const atLimit = (data?.history.length || 0) >= 100;
  const selected = data?.history.find(
    (item) => String(item.revision) === editor?.targetRevision,
  );
  const sameRollback =
    selected &&
    data?.state.active &&
    sameConfig(selected.config, data.state.active.config);
  const blocked = busy || reading || locked;
  function submit(event: FormEvent, kind: "draft" | "publish" | "rollback") {
    event.preventDefault();
    void mutate(kind);
  }

  return (
    <>
      <a href="#/flags" className="back-link">
        All flags
      </a>
      <PageHeading
        title={data?.flag.name || flagKey}
        actions={
          <button disabled={busy || reading} onClick={() => void read(true)}>
            {reading ? "Refreshing…" : "Refresh flag"}
          </button>
        }
      >
        {data?.flag.description || "Reading flag configuration."}
      </PageHeading>
      <div className="context-bar">
        <code>{flagKey}</code>
        <span className="environment-label">{environment}</span>
        <span>
          State version{" "}
          <strong data-testid="state-version">
            {data?.state.version ?? "…"}
          </strong>
        </span>
        <div className="environment-links" aria-label="Flag environment">
          <a
            href={`#/flags/${flagKey}/staging`}
            aria-current={environment === "staging" ? "page" : undefined}
          >
            Staging
          </a>
          <a
            href={`#/flags/${flagKey}/production`}
            aria-current={environment === "production" ? "page" : undefined}
          >
            Production
          </a>
        </div>
      </div>
      {error && <Message>{error}</Message>}
      {locked && (
        <Message tone="warning">
          Writes paused. The last outcome is stale or unconfirmed. Use Refresh
          flag to reconcile, then review the current version. Your edits and
          notes are retained.
        </Message>
      )}
      {notice && <Message tone="success">{notice}</Message>}
      <Updated at={readAt} />
      {!data || !editor ? (
        reading ? (
          <p role="status">Loading flag detail…</p>
        ) : (
          <p>Flag data is unavailable. Use Refresh flag to try again.</p>
        )
      ) : (
        <>
          <div className="comparison">
            <section
              className="sheet draft-sheet"
              aria-labelledby="draft-heading"
            >
              <div className="section-heading">
                <h2 id="draft-heading">Draft configuration</h2>
                <span>{dirty ? "Unsaved edits" : "Saved draft"}</span>
              </div>
              <p>
                Save edits here, then publish the saved draft. Clients do not
                read this form.
              </p>
              <form onSubmit={(event) => submit(event, "draft")} noValidate>
                <label className="check-label" htmlFor="draft-enabled">
                  <input
                    id="draft-enabled"
                    type="checkbox"
                    checked={editor.enabled}
                    onChange={(event) =>
                      update({ enabled: event.target.checked })
                    }
                    disabled={busy}
                  />
                  <span>Enable flag in draft</span>
                </label>
                <label htmlFor="draft-percentage">Rollout percentage</label>
                <div className="percentage-input">
                  <input
                    id="draft-percentage"
                    type="text"
                    inputMode="decimal"
                    value={editor.percentage}
                    onChange={(event) =>
                      update({ percentage: event.target.value })
                    }
                    aria-describedby="percentage-help"
                    disabled={busy}
                  />
                  <span>%</span>
                </div>
                <p id="percentage-help" className="field-help">
                  0 to 100, with at most two decimal places. The threshold uses
                  10,000 stable buckets.
                </p>
                <label htmlFor="draft-allowlist">Allowlisted subject IDs</label>
                <textarea
                  id="draft-allowlist"
                  value={editor.allowlist}
                  onChange={(event) =>
                    update({ allowlist: event.target.value })
                  }
                  aria-describedby="allowlist-help"
                  rows={5}
                  spellCheck={false}
                  disabled={busy}
                />
                <p id="allowlist-help" className="field-help">
                  {editor.allowlist.trim()
                    ? editor.allowlist.split(/\r?\n/).length
                    : 0}{" "}
                  / 20 subjects. One per line. ASCII letters, digits, dot,
                  underscore or hyphen; case sensitive. Disabled flags always
                  return false.
                </p>
                {validation && (
                  <p className="validation" role="status">
                    {validation}
                  </p>
                )}
                <button
                  className="primary"
                  disabled={blocked || !dirty || !!validation}
                >
                  {busy ? "Writing…" : "Save draft"}
                </button>
              </form>
              <details className="saved-config">
                <summary>Inspect stored draft JSON</summary>
                <pre>{JSON.stringify(data.state.draft, null, 2)}</pre>
              </details>
            </section>
            <section
              className="sheet active-sheet"
              aria-labelledby="active-heading"
            >
              <div className="section-heading">
                <h2 id="active-heading">Active publication</h2>
                <span data-testid="active-revision">
                  {data.state.active
                    ? `Revision ${data.state.active.revision}`
                    : "Unpublished"}
                </span>
              </div>
              {data.state.active ? (
                <>
                  <ConfigSummary config={data.state.active.config} />
                  <p className="publication-note">{data.state.active.note}</p>
                  <p className="small muted">
                    {data.state.active.kind === "ROLLBACK"
                      ? `Rollback copied revision ${data.state.active.sourceRevision}. `
                      : "Published saved draft. "}
                    {displayTime(data.state.active.createdAt)} ·{" "}
                    {data.state.active.actor}
                  </p>
                </>
              ) : (
                <div className="unpublished">
                  <strong>No active revision</strong>
                  <p>
                    Clients receive false with reason UNPUBLISHED. Saving a
                    draft does not create a publication.
                  </p>
                </div>
              )}
              <div className="publish-section">
                <h3>Publish saved draft</h3>
                <p>
                  Creates an immutable revision for{" "}
                  <strong>{environment}</strong>. The saved draft remains
                  available to edit.
                </p>
                <form onSubmit={(event) => submit(event, "publish")} noValidate>
                  <label htmlFor="publish-note">Publication note</label>
                  <textarea
                    id="publish-note"
                    rows={3}
                    value={editor.publishNote}
                    onChange={(event) =>
                      update({ publishNote: event.target.value })
                    }
                    disabled={busy}
                    aria-describedby="publish-help"
                  />
                  <p id="publish-help" className="field-help">
                    {[...editor.publishNote.trim()].length} / 500 characters.
                    Use at least 10. Describe the reason for this release.
                  </p>
                  <button
                    className="primary"
                    disabled={
                      blocked ||
                      dirty ||
                      !!noPublicationChange ||
                      atLimit ||
                      !!noteError(editor.publishNote)
                    }
                  >
                    Publish saved draft
                  </button>
                </form>
                {dirty && (
                  <p className="field-help">
                    Save your edited configuration before publishing.
                  </p>
                )}
                {noPublicationChange && (
                  <p className="field-help">
                    The saved draft already matches the active publication.
                  </p>
                )}
                {atLimit && (
                  <Message tone="warning">
                    This environment has reached its 100-publication limit.
                  </Message>
                )}
              </div>
            </section>
          </div>
          <section
            className="history-section"
            aria-labelledby="history-heading"
          >
            <div className="section-heading">
              <div>
                <h2 id="history-heading">Publication history</h2>
                <p>
                  Newest first. Every rollback appends a revision and preserves
                  the draft.
                </p>
              </div>
              <span>{data.history.length} / 100 revisions</span>
            </div>
            {data.history.length === 0 ? (
              <div className="empty-state">
                No publications yet. Save and publish a draft to start this
                environment’s history.
              </div>
            ) : (
              <div
                className="table-scroll"
                role="region"
                aria-label="Publication history table"
                tabIndex={0}
              >
                <table>
                  <thead>
                    <tr>
                      <th>Revision</th>
                      <th>Operation</th>
                      <th>Configuration</th>
                      <th>Release note</th>
                      <th>Published</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.history.map((publication) => (
                      <tr key={publication.revision}>
                        <td>
                          <strong>{publication.revision}</strong>
                          {publication.revision ===
                            data.state.active?.revision && (
                            <span className="table-sub">Active</span>
                          )}
                        </td>
                        <td>
                          {publication.kind === "PUBLISH"
                            ? "Publish"
                            : `Rollback from ${publication.sourceRevision}`}
                        </td>
                        <td>
                          {publication.config.enabled ? "Enabled" : "Disabled"}
                          <span className="table-sub">
                            {publication.config.rolloutBasisPoints / 100}% ·{" "}
                            {publication.config.allowlist.length} allowlisted
                          </span>
                          <details>
                            <summary>Configuration JSON</summary>
                            <pre>
                              {JSON.stringify(publication.config, null, 2)}
                            </pre>
                          </details>
                        </td>
                        <td className="note-cell">{publication.note}</td>
                        <td>
                          {displayTime(publication.createdAt)}
                          <span className="table-sub">{publication.actor}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          {data.history.length > 0 && (
            <section
              className="rollback-section"
              aria-labelledby="rollback-heading"
            >
              <div>
                <h2 id="rollback-heading">Roll back active configuration</h2>
                <p>
                  Copy a historical configuration into a new active revision.
                  This leaves your saved draft and unsaved edits intact.
                </p>
              </div>
              <form onSubmit={(event) => submit(event, "rollback")} noValidate>
                <label htmlFor="rollback-target">Historical revision</label>
                <select
                  id="rollback-target"
                  value={editor.targetRevision}
                  onChange={(event) =>
                    update({ targetRevision: event.target.value })
                  }
                  disabled={busy}
                >
                  <option value="">Choose a revision</option>
                  {data.history.map((item) => (
                    <option key={item.revision} value={item.revision}>
                      Revision {item.revision}
                      {item.revision === data.state.active?.revision
                        ? " (active)"
                        : ""}
                    </option>
                  ))}
                </select>
                <label htmlFor="rollback-note">Rollback note</label>
                <textarea
                  id="rollback-note"
                  rows={3}
                  value={editor.rollbackNote}
                  onChange={(event) =>
                    update({ rollbackNote: event.target.value })
                  }
                  disabled={busy}
                />
                <p className="field-help">
                  10 to 500 characters. Explain which behavior you are
                  restoring.
                </p>
                <button
                  disabled={
                    blocked ||
                    atLimit ||
                    !selected ||
                    !!sameRollback ||
                    !!noteError(editor.rollbackNote)
                  }
                >
                  Publish rollback revision
                </button>
                {sameRollback && (
                  <p className="field-help">
                    This historical configuration already matches the active
                    publication.
                  </p>
                )}
              </form>
            </section>
          )}
        </>
      )}
    </>
  );
}
