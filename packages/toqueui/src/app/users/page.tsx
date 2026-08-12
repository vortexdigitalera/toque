"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { listUsers, createUser, deleteUser } from "@/lib/api";
import type { UserProfile } from "@toque/shared";
import { PageHeader, Card, Button, Input, Select, Tag, LoadingState, ErrorState } from "@/components/ui";

export default function UsersPage() {
  const { user } = useAuth();
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState("viewer");
  const [error, setError] = useState<string | null>(null);

  const isAdmin = user?.role === "super_admin" || user?.role === "admin";

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    listUsers().then((res) => {
      setUsers(res.users || []);
      setLoading(false);
    });
  }, [isAdmin]);

  const handleCreate = async () => {
    setError(null);
    const res = await createUser(newEmail, newName, newRole);
    if (res.ok && res.user) {
      setUsers([...users, res.user]);
      setNewEmail("");
      setNewName("");
      setShowCreate(false);
    } else {
      setError(res.error || "Failed to create user");
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this user?")) return;
    const res = await deleteUser(id);
    if (res.ok) {
      setUsers(users.filter((u) => u.id !== id));
    }
  };

  if (!isAdmin) return <ErrorState message="Admin access required." />;
  if (loading) return <LoadingState message="Loading team…" />;

  return (
    <div>
      <PageHeader
        title="Team Management"
        subtitle="Manage user roles and access"
        action={
          <Button onClick={() => setShowCreate(!showCreate)}>
            {showCreate ? "Cancel" : "+ Add User"}
          </Button>
        }
      />

      {showCreate && (
        <Card className="mb-6">
          <h3 className="page-title" style={{ fontSize: 18, marginBottom: 16 }}>Create New User</h3>
          {error && (
            <div className="mb-4">
              <ErrorState message={error} />
            </div>
          )}
          <div className="form-grid">
            <Input
              label="Email"
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="user@example.com"
            />
            <Input
              label="Full Name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="John Doe"
            />
            <Select label="Role" value={newRole} onChange={(e) => setNewRole(e.target.value)}>
              <option value="viewer">Viewer</option>
              <option value="operator">Operator</option>
              <option value="admin">Admin</option>
              <option value="super_admin">Super Admin</option>
            </Select>
          </div>
          <div className="mt-4">
            <Button onClick={handleCreate}>Create</Button>
          </div>
        </Card>
      )}

      <Card>
        <table className="data-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Role</th>
              <th>Created</th>
              {user?.role === "super_admin" && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>{u.fullName || "—"}</td>
                <td>
                  <Tag variant={u.role === "super_admin" ? "red" : u.role === "admin" ? "yellow" : "blue"}>
                    {u.role}
                  </Tag>
                </td>
                <td>{new Date(u.createdAt).toLocaleDateString()}</td>
                {user?.role === "super_admin" && (
                  <td>
                    {u.id !== user.id && (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => handleDelete(u.id)}
                      >
                        Delete
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
