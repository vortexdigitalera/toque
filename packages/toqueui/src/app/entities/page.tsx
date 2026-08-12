"use client";

import { useEffect, useState } from "react";
import { listEntities, getEntityContext } from "@/lib/api";
import { PageHeader, Card, Tag, LoadingState, EmptyState } from "@/components/ui";

export default function EntitiesPage() {
  const [entities, setEntities] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [context, setContext] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listEntities().then((res) => {
      setEntities(res.entities || []);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!selected) return;
    setContext(null);
    getEntityContext(selected).then((res) => {
      if (res.ok) setContext(res);
    });
  }, [selected]);

  return (
    <div>
      <PageHeader
        title="Entities"
        subtitle="Manage Nusuk entity contexts and auth tokens"
      />

      {loading ? (
        <LoadingState message="Loading entities…" />
      ) : entities.length === 0 ? (
        <EmptyState icon="◈" message="No entities found. Upload tokens via the autha extension to populate the store." />
      ) : (
        <div className="entity-grid">
          {entities.map((id) => (
            <Card
              key={id}
              className={selected === id ? "entity-card selected" : "entity-card"}
            >
              <div
                style={{ cursor: "pointer" }}
                onClick={() => setSelected(id)}
              >
                <Tag variant="blue">{id}</Tag>
                <p style={{ marginTop: 8, fontSize: 12, color: "var(--text-dim)" }}>
                  Click to view auth context
                </p>
              </div>
            </Card>
          ))}
        </div>
      )}

      {selected && (
        <Card className="mt-6">
          <h3 className="page-title" style={{ fontSize: 18, marginBottom: 16 }}>
            Entity: <Tag variant="blue">{selected}</Tag>
          </h3>
          {!context ? (
            <LoadingState message="Loading context…" />
          ) : (
            <table className="data-table">
              <tbody>
                <tr>
                  <th>Auth Token</th>
                  <td>{(context as Record<string, unknown>)?.auth ? "✅ Present" : "❌ Missing"}</td>
                </tr>
                <tr>
                  <th>Token Type</th>
                  <td>{String(((context as Record<string, unknown>)?.auth as Record<string, unknown>)?.tokenType || "—")}</td>
                </tr>
                <tr>
                  <th>Captcha (visa)</th>
                  <td>{((context as Record<string, unknown>)?.captcha as Record<string, unknown>)?.visa ? "✅ Present" : "❌ Missing"}</td>
                </tr>
                <tr>
                  <th>Captcha (login)</th>
                  <td>{((context as Record<string, unknown>)?.captcha as Record<string, unknown>)?.login ? "✅ Present" : "❌ Missing"}</td>
                </tr>
              </tbody>
            </table>
          )}
        </Card>
      )}
    </div>
  );
}
