"use client";

import { useEffect, useState } from "react";

import { AdminGuard } from "@/components/admin/AdminGuard";
import { AdminTopbar } from "@/components/admin/AdminTopbar";
import { adminFetch } from "@/lib/adminClient";

type OverviewPayload = {
  overview: Record<string, string | number | null>;
  topUsers: Array<Record<string, string | number | null>>;
};

export default function AdminDashboardPage() {
  const [data, setData] = useState<OverviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminFetch<OverviewPayload>("/api/admin/overview")
      .then(setData)
      .catch((requestError) =>
        setError(requestError instanceof Error ? requestError.message : "Failed to load overview"),
      );
  }, []);

  return (
    <AdminGuard>
      <main className="mx-auto max-w-6xl px-6 py-6">
        <AdminTopbar />
        <h1 className="mb-4 text-2xl font-semibold">Security Dashboard</h1>
        {error ? <p className="mb-4 text-sm text-red-600">{error}</p> : null}
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Object.entries(data?.overview ?? {}).map(([key, value]) => (
            <article key={key} className="rounded-xl border border-neutral-200 p-4">
              <p className="text-xs uppercase text-neutral-500">{key}</p>
              <p className="mt-1 text-xl font-semibold">{String(value ?? "-")}</p>
            </article>
          ))}
        </section>
        <section className="mt-6 rounded-xl border border-neutral-200 p-4">
          <h2 className="mb-3 text-lg font-semibold">Top active users (24h)</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-neutral-500">
                <tr>
                  <th className="pb-2 pr-3">Telegram</th>
                  <th className="pb-2 pr-3">Username</th>
                  <th className="pb-2 pr-3">Requests</th>
                  <th className="pb-2 pr-3">Errors</th>
                </tr>
              </thead>
              <tbody>
                {(data?.topUsers ?? []).map((row) => (
                  <tr key={String(row.profile_id)} className="border-t border-neutral-100">
                    <td className="py-2 pr-3">{String(row.telegram_id ?? "-")}</td>
                    <td className="py-2 pr-3">{String(row.username ?? "-")}</td>
                    <td className="py-2 pr-3">{String(row.request_count ?? 0)}</td>
                    <td className="py-2 pr-3">{String(row.error_count ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </AdminGuard>
  );
}
