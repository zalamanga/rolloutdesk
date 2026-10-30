import type { ReactNode } from "react";
import type { Config, EnvironmentState } from "./types";
import { displayTime, formatPercentage } from "./utils";

export function Message({
  children,
  tone = "error",
}: {
  children: ReactNode;
  tone?: "error" | "success" | "warning";
}) {
  return (
    <div
      className={`message ${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

export function PageHeading({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{children}</p>
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function StateSummary({ state }: { state: EnvironmentState }) {
  return (
    <>
      <strong>
        {state.active ? `Revision ${state.active.revision}` : "Unpublished"}
      </strong>
      {state.active && (
        <span>
          {state.active.config.enabled
            ? `${formatPercentage(state.active.config.rolloutBasisPoints)}% rollout`
            : "Disabled"}
        </span>
      )}
      <span className="muted">
        {state.active
          ? `${state.active.config.allowlist.length} allowlisted`
          : "Clients receive false"}
      </span>
    </>
  );
}

export function ConfigSummary({ config }: { config: Config }) {
  return (
    <dl className="facts">
      <div>
        <dt>Switch</dt>
        <dd>{config.enabled ? "Enabled" : "Disabled"}</dd>
      </div>
      <div>
        <dt>Rollout threshold</dt>
        <dd>
          {formatPercentage(config.rolloutBasisPoints)}%{" "}
          <span className="muted">
            ({config.rolloutBasisPoints} / 10000 buckets)
          </span>
        </dd>
      </div>
      <div>
        <dt>Allowlist</dt>
        <dd>
          {config.allowlist.length ? (
            <ul className="subjects">
              {config.allowlist.map((subject) => (
                <li key={subject}>
                  <code>{subject}</code>
                </li>
              ))}
            </ul>
          ) : (
            "No subjects"
          )}
        </dd>
      </div>
    </dl>
  );
}

export function Updated({ at }: { at: string | null }) {
  return (
    <p className="read-time">
      {at ? (
        <>
          Read at <time dateTime={at}>{displayTime(at)}</time>. Refresh to read
          newer changes.
        </>
      ) : (
        "No successful server read yet."
      )}
    </p>
  );
}
