"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

const REFRESH_INTERVAL_MS = 15_000;

export function LiveStatusRefresh() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (pathname === "/login") return;

    let timeout: number | undefined;

    function scheduleRefresh() {
      window.clearTimeout(timeout);
      if (document.visibilityState !== "visible") return;

      timeout = window.setTimeout(() => {
        router.refresh();
        scheduleRefresh();
      }, REFRESH_INTERVAL_MS);
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") router.refresh();
      scheduleRefresh();
    }

    scheduleRefresh();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearTimeout(timeout);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [pathname, router]);

  return null;
}
