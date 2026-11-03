"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

export interface ThemeToggleProps
  extends Omit<ComponentPropsWithoutRef<"button">, "children" | "onClick"> {
  iconClassName?: string;
}

/** Apply the theme directly. Whole-window snapshots and masks are expensive
 * in the desktop workbench, especially with software rendering on Windows. */
export function useThemeToggle() {
  const { setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isDark = mounted && resolvedTheme === "dark";
  const toggle = () => {
    // Read the applied class so rapid clicks do not depend on a stale render.
    setTheme(document.documentElement.classList.contains("dark") ? "light" : "dark");
  };
  return { isDark, mounted, toggle };
}

export function ThemeToggle({ className, iconClassName, ...rest }: ThemeToggleProps) {
  const { isDark, mounted, toggle } = useThemeToggle();
  return (
    <button
      {...rest}
      type="button"
      aria-label={mounted && isDark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={toggle}
      className={cn("flex items-center justify-center", className)}
    >
      {mounted ? (
        isDark ? <Sun className={iconClassName} /> : <Moon className={iconClassName} />
      ) : <span className={iconClassName} aria-hidden="true" />}
    </button>
  );
}
