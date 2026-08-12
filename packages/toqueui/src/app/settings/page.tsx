"use client";

import { useEffect, useState } from "react";
import { listSettings, upsertSettings } from "@/lib/api";
import { PageHeader, Card, Button, Input, Tag, LoadingState, Toast } from "@/components/ui";

export default function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ message: string; variant: "success" | "error" } | null>(null);

  useEffect(() => {
    listSettings().then((res) => {
      setSettings(res.settings || {});
      setEdited(res.settings || {});
      setLoading(false);
    });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setToast(null);
    // Only send changed keys
    const changes: Record<string, string> = {};
    for (const [key, value] of Object.entries(edited)) {
      if (settings[key] !== value) changes[key] = value;
    }
    if (Object.keys(changes).length === 0) {
      setToast({ message: "No changes to save.", variant: "error" });
      setSaving(false);
      return;
    }
    const res = await upsertSettings(changes);
    if (res.ok) {
      setSettings({ ...settings, ...changes });
      setToast({ message: `Saved ${res.count} setting(s).`, variant: "success" });
    } else {
      setToast({ message: `Error: ${res.error}`, variant: "error" });
    }
    setSaving(false);
  };

  const knownKeys = [
    "captcha.provider",
    "captcha.capmonsterApiKey",
    "captcha.capsolverApiKey",
    "captcha.siteKey",
    "captcha.pageUrl",
    "captcha.pageAction",
    "captcha.minScore",
    "nusuk.activeEntityId",
    "nusuk.activeEntityTypeId",
    "nusuk.systemUserId",
    "container.maxInstances",
    "container.sleepAfter",
    "container.instanceType",
  ];

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Platform configuration stored in D1 (app_db) and synced across the mesh"
      />

      {loading ? (
        <LoadingState message="Loading settings…" />
      ) : (
        <Card>
          <div className="settings-grid">
            {knownKeys.map((key) => (
              <Input
                key={key}
                label={key}
                type={key.includes("ApiKey") ? "password" : "text"}
                value={edited[key] || ""}
                onChange={(e) => setEdited({ ...edited, [key]: e.target.value })}
                placeholder={settings[key] || "not set"}
              />
            ))}
            {/* Show any unknown keys that exist in D1 */}
            {Object.keys(settings)
              .filter((k) => !knownKeys.includes(k))
              .map((key) => (
                <div key={key} className="form-group">
                  <label className="form-label">
                    {key} <Tag variant="yellow">custom</Tag>
                  </label>
                  <input
                    className="form-input"
                    value={edited[key] || ""}
                    onChange={(e) => setEdited({ ...edited, [key]: e.target.value })}
                  />
                </div>
              ))}
          </div>
          <div className="mt-4">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save Changes"}
            </Button>
          </div>
          {toast && (
            <div className="mt-4">
              <Toast message={toast.message} variant={toast.variant} />
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
