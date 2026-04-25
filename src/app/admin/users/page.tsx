"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AdminGuard } from "@/components/admin/AdminGuard";
import { AdminTopbar } from "@/components/admin/AdminTopbar";
import { adminFetch } from "@/lib/adminClient";

type UserRow = {
  id: string;
  telegram_id: number | null;
  username: string | null;
  created_at: string;
  active_block: {
    block_type?: string;
    reason?: string;
    ends_at?: string | null;
  } | null;
};

export default function AdminUsersPage() {
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<UserRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function loadUsers(search: string) {
    try {
      const payload = await adminFetch<UserRow[]>(
        `/api/admin/users${search ? `?query=${encodeURIComponent(search)}` : ""}`,
      );
      setUsers(payload);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to load users");
    }
  }

  useEffect(() => {
    let mounted = true;
    adminFetch<UserRow[]>("/api/admin/users")
      .then((payload) => {
        if (!mounted) {
          return;
        }
        setUsers(payload);
      })
      .catch((requestError) => {
        if (!mounted) {
          return;
        }
        setError(requestError instanceof Error ? requestError.message : "Failed to load users");
      });
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <AdminGuard>
      <main className="mx-auto max-w-6xl px-6 py-6">
        <AdminTopbar />
        <h1 className="mb-4 text-2xl font-semibold">Users</h1>
        <form
          className="mb-4 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            loadUsers(query.trim());
          }}
        >
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Telegram ID or username"
            className="w-full rounded-lg border border-neutral-300 px-3 py-2"
          />
          <button type="submit" className="rounded-lg bg-neutral-900 px-3 py-2 text-white">
            Search
          </button>
        </form>
        {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}
        <div className="overflow-x-auto rounded-xl border border-neutral-200">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-neutral-50 text-neutral-500">
              <tr>
                <th className="px-3 py-2">Telegram</th>
                <th className="px-3 py-2">Username</th>
                <th className="px-3 py-2">Created</th>
                <th className="px-3 py-2">Block status</th>
                <th className="px-3 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-t border-neutral-100">
                  <td className="px-3 py-2">{user.telegram_id ?? "-"}</td>
                  <td className="px-3 py-2">{user.username ?? "-"}</td>
                  <td className="px-3 py-2">{new Date(user.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    {user.active_block ? `${user.active_block.block_type ?? "blocked"}: ${user.active_block.reason ?? ""}` : "active"}
                  </td>
                  <td className="px-3 py-2">
                    <Link href={`/admin/users/${user.id}`} className="text-blue-700 underline">
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </AdminGuard>
  );
}
