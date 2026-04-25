"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { adminFetch } from "@/lib/adminClient";

type AdminMe = {
  id: string;
  email: string;
  role: string;
};

export function AdminGuard({ children }: { children: React.ReactNode }) {
  const [isReady, setIsReady] = useState(false);
  const [admin, setAdmin] = useState<AdminMe | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    let mounted = true;
    adminFetch<AdminMe>("/api/admin/me")
      .then((data) => {
        if (!mounted) {
          return;
        }
        setAdmin(data);
        setIsReady(true);
      })
      .catch(() => {
        if (!mounted) {
          return;
        }
        const returnTo = encodeURIComponent(pathname || "/admin");
        router.replace(`/admin/login?next=${returnTo}`);
      });
    return () => {
      mounted = false;
    };
  }, [pathname, router]);

  if (!isReady || !admin) {
    return <div className="p-8 text-sm text-neutral-500">Checking admin session...</div>;
  }

  return <>{children}</>;
}
