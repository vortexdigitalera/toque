"use client";

import { useEffect, useState, useRef } from "react";
import { listAuditLogs, connectAuditStream } from "@/lib/api";
import type { AuditLog } from "@toque/shared";
import { PageHeader, Card, Tag, LoadingState, EmptyState } from "@/components/ui";

export default function AuditPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [liveLogs, setLiveLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    listAuditLogs({ limit: 50 }).then((res) => {
      setLogs(res.logs || []);
      setLoading(false);
    });

    // Connect WebSocket for live audit stream
    const ws = connectAuditStream((log) => {
      setLiveLogs((prev) => [log, ...prev].slice(0, 50));
    });
    wsRef.current = ws;

    return () => {
      ws?.close();
    };
  }, []);

  const allLogs = [...liveLogs, ...logs];

  return (
    <div>
      <PageHeader
        title="Audit Logs"
        subtitle="Real-time stream of all mesh activity"
        action={
          liveLogs.length > 0 ? (
            <Tag variant="green">● {liveLogs.length} new</Tag>
          ) : undefined
        }
      />

      <Card>
        <div className="audit-stream">
          {loading ? (
            <LoadingState message="Loading logs…" />
          ) : allLogs.length === 0 ? (
            <EmptyState icon="≡" message="No audit logs yet." />
          ) : (
            allLogs.map((log, i) => (
              <div key={i} className="audit-entry">
                <span className="audit-action">{log.action}</span>
                {log.panel && <Tag variant="blue">{log.panel}</Tag>}
                {log.userEmail && (
                  <span className="audit-user">{log.userEmail}</span>
                )}
                <span className="audit-time">
                  {new Date(log.createdAt).toLocaleString()}
                </span>
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}
