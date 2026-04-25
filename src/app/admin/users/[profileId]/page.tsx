"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { AdminGuard } from "@/components/admin/AdminGuard";
import { AdminTopbar } from "@/components/admin/AdminTopbar";
import { adminFetch } from "@/lib/adminClient";

type UserCard = {
  profile: Record<string, unknown>;
  blocks: Array<Record<string, unknown>>;
  recent_requests: Array<Record<string, unknown>>;
  households: Array<Record<string, unknown>>;
};

export default function AdminUserDetailsPage() {
  const params = useParams<{ profileId: string }>();
  const profileId = params.profileId;
  const [data, setData] = useState<UserCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [blockType, setBlockType] = useState<"temporary" | "permanent">("temporary");
  const [endsAt, setEndsAt] = useState("");

  async function loadProfile() {
    try {
      setError(null);
      const payload = await adminFetch<UserCard>(`/api/admin/users/${profileId}`);
      setData(payload);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to load user");
    }
  }

  useEffect(() => {
    let mounted = true;
    if (!profileId) {
      return;
    }
    adminFetch<UserCard>(`/api/admin/users/${profileId}`)
      .then((payload) => {
        if (!mounted) {
          return;
        }
        setData(payload);
      })
      .catch((requestError) => {
        if (!mounted) {
          return;
        }
        setError(requestError instanceof Error ? requestError.message : "Failed to load user");
      });
    return () => {
      mounted = false;
    };
  }, [profileId]);

  async function blockUser() {
    try {
      await adminFetch(`/api/admin/users/${profileId}/block`, {
        method: "POST",
        body: JSON.stringify({
          reason,
          blockType,
          endsAt: blockType === "temporary" ? endsAt : null,
        }),
      });
      setReason("");
      setEndsAt("");
      await loadProfile();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to block user");
    }
  }

  async function unblockUser() {
    try {
      await adminFetch(`/api/admin/users/${profileId}/block`, { method: "DELETE" });
      await loadProfile();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to unblock user");
    }
  }

  return (
    <AdminGuard>
      <main className="mx-auto max-w-6xl px-6 py-6">
        <AdminTopbar />
        <h1 className="mb-4 text-2xl font-semibold">User card</h1>
        {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}
        <section className="mb-4 rounded-xl border border-neutral-200 p-4">
          <h2 className="mb-2 font-semibold">Profile</h2>
          <pre className="overflow-x-auto rounded bg-neutral-50 p-3 text-xs">
            {JSON.stringify(data?.profile ?? {}, null, 2)}
          </pre>
        </section>
        <section className="mb-4 rounded-xl border border-neutral-200 p-4">
          <h2 className="mb-2 font-semibold">Block / Unblock</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Block reason"
              className="rounded-lg border border-neutral-300 px-3 py-2"
            />
            <select
              value={blockType}
              onChange={(event) => setBlockType(event.target.value === "permanent" ? "permanent" : "temporary")}
              className="rounded-lg border border-neutral-300 px-3 py-2"
            >
              <option value="temporary">temporary</option>
              <option value="permanent">permanent</option>
            </select>
            <input
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
              placeholder="endsAt ISO (for temporary)"
              className="rounded-lg border border-neutral-300 px-3 py-2 sm:col-span-2"
            />
          </div>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={blockUser} className="rounded-lg bg-red-700 px-3 py-2 text-white">
              Block
            </button>
            <button type="button" onClick={unblockUser} className="rounded-lg border border-neutral-300 px-3 py-2">
              Unblock
            </button>
          </div>
        </section>
        <section className="mb-4 rounded-xl border border-neutral-200 p-4">
          <h2 className="mb-2 font-semibold">Recent requests</h2>
          <pre className="overflow-x-auto rounded bg-neutral-50 p-3 text-xs">
            {JSON.stringify(data?.recent_requests ?? [], null, 2)}
          </pre>
        </section>
        <section className="rounded-xl border border-neutral-200 p-4">
          <h2 className="mb-2 font-semibold">Block history</h2>
          <pre className="overflow-x-auto rounded bg-neutral-50 p-3 text-xs">
            {JSON.stringify(data?.blocks ?? [], null, 2)}
          </pre>
        </section>
      </main>
    </AdminGuard>
  );
}
