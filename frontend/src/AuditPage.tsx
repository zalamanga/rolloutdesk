import { useEffect, useState } from "react";
import { Api } from "./api";
import type { AuditItem, Page } from "./types";
import { Message, PageHeading, Updated } from "./components";
import { displayTime } from "./utils";

export default function AuditPage({ api }: { api: Api }) {
  const [page, setPage] = useState(0);
  const [data, setData] = useState<Page<AuditItem> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [readAt, setReadAt] = useState<string | null>(null);
  async function read() {
    setPending(true);
    setError("");
    try {
      setData(await api.request<Page<AuditItem>>(`/api/audit?page=${page}`));
      setReadAt(new Date().toISOString());
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPending(false);
    }
  }
  useEffect(() => {
    void read();
  }, [page]);
  return (
    <>
      <PageHeading
        title="Audit history"
        actions={
          <button onClick={() => void read()} disabled={pending}>
            {pending ? "Refreshing…" : "Refresh audit"}
          </button>
        }
      >
        Stored draft saves, publications and rollbacks across both environments.
        Newest first.
      </PageHeading>
      {error && <Message>{error}</Message>}
      <Updated at={readAt} />
      {!data ? (
        pending ? (
          <p role="status">Loading audit history…</p>
        ) : (
          <p>Audit data is unavailable. Use Refresh audit to try again.</p>
        )
      ) : data.items.length === 0 ? (
        <div className="empty-state">
          <h2>No audit entries on this page</h2>
          <p>
            Saving a changed draft or publishing a revision creates an entry.
          </p>
        </div>
      ) : (
        <div
          className="table-scroll"
          role="region"
          aria-label="Audit table"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th>Time and actor</th>
                <th>Action</th>
                <th>Flag and environment</th>
                <th>Revision</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    {displayTime(item.createdAt)}
                    <span className="table-sub">{item.actor}</span>
                  </td>
                  <td>{item.action.replaceAll("_", " ").toLowerCase()}</td>
                  <td>
                    <a href={`#/flags/${item.flagKey}/${item.environment}`}>
                      <code>{item.flagKey}</code>
                      <span className="table-sub">{item.environment}</span>
                    </a>
                  </td>
                  <td>{item.revision ?? "Draft"}</td>
                  <td className="note-cell">
                    {item.note || "Draft configuration saved"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="pagination">
        <span>{data ? `${data.total} entries · Page ${page + 1}` : ""}</span>
        <div className="actions">
          <button
            onClick={() => {
              setData(null);
              setPage((value) => Math.max(0, value - 1));
            }}
            disabled={pending || page === 0}
          >
            Previous page
          </button>
          <button
            onClick={() => {
              setData(null);
              setPage((value) => value + 1);
            }}
            disabled={
              pending || !data || (page + 1) * data.pageSize >= data.total
            }
          >
            Next page
          </button>
        </div>
      </div>
    </>
  );
}
