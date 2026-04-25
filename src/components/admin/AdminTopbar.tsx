"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { adminFetch } from "@/lib/adminClient";

const LINKS = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/security-events", label: "Security events" },
];

export function AdminTopbar() {
  const pathname = usePathname();
  const router = useRouter();

  async function onLogout() {
    await adminFetch("/api/admin/logout", { method: "POST" });
    router.push("/admin/login");
  }

  return (
    <header className="mb-6 flex items-center justify-between border-b border-neutral-200 pb-4">
      <nav className="flex gap-2">
        {LINKS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              pathname === item.href ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-700"
            }`}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <button
        type="button"
        onClick={onLogout}
        className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100"
      >
        Logout
      </button>
    </header>
  );
}
