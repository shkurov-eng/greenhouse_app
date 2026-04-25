"use client";

import { useEffect, useState } from "react";

import { AdminGuard } from "@/components/admin/AdminGuard";
import { AdminTopbar } from "@/components/admin/AdminTopbar";
import { adminFetch } from "@/lib/adminClient";

export default function AdminSecurityEventsPage() {
  const [events, setEvents] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminFetch<Array<Record<string, unknown>>>("/api/admin/security-events")
      .then(setEvents)
      .catch((requestError) =>
        setError(requestError instanceof Error ? requestError.message : "Failed to load events"),
      );
  }, []);

  return (
    <AdminGuard>
      <main className="mx-auto max-w-6xl px-6 py-6">
        <AdminTopbar />
        <h1 className="mb-4 text-2xl font-semibold">Security events</h1>
        {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}
        <pre className="overflow-x-auto rounded-xl border border-neutral-200 bg-neutral-50 p-4 text-xs">
          {JSON.stringify(events, null, 2)}
        </pre>
      </main>
    </AdminGuard>
  );
}
