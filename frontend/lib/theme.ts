"use client";

import { useCallback, useSyncExternalStore } from "react";

export const THEME_STORAGE_KEY = "chessdna.theme";

export type Theme = "light" | "dark";

/** Read the current theme from the <html> class (set pre-paint by the
 *  layout script; default light when no saved preference exists). */
export function currentTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // localStorage unavailable — theme still applies for this session
  }
}

function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

/** Reactive theme state: follows the <html> class via
 *  useSyncExternalStore, so board square colors, charts and toggles all
 *  update when the user flips the theme. Server snapshot is light (the
 *  default); the client re-reads the real class on hydration. */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, (): Theme => "light");
  const toggle = useCallback(() => {
    applyTheme(currentTheme() === "dark" ? "light" : "dark");
  }, []);
  return { theme, toggle };
}
