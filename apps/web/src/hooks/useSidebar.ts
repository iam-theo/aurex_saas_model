import { useState, useEffect, useCallback } from "react";

const SIDEBAR_KEY = "aurex.sidebar.open";
const SIDEBAR_WIDTH = 256;
const SIDEBAR_COLLAPSED = 56;
const COLLAPSE_BELOW = 900;

function getInitial(): boolean {
  try {
    const v = localStorage.getItem(SIDEBAR_KEY);
    if (v !== null) return v === "true";
  } catch {}
  return window.innerWidth >= COLLAPSE_BELOW;
}

export function useSidebar() {
  const [open, setOpen] = useState<boolean>(getInitial);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${COLLAPSE_BELOW - 1}px)`);
    const handler = (e: MediaQueryListEvent | MediaQueryList) => {
      if (e.matches) setOpen(false);
    };
    handler(mql);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, String(open));
    } catch {}
  }, [open]);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  return { open, toggle, width: open ? SIDEBAR_WIDTH : SIDEBAR_COLLAPSED, SIDEBAR_WIDTH };
}
