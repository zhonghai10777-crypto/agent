import { useEffect, useState } from "react";

/** Keep in sync with the `@media (max-width: 760px)` query in sidebar.css that turns
 * the primary sidebar into an overlay drawer. */
export const NARROW_LAYOUT_BREAKPOINT_PX = 760;

/** True while the window is narrow enough that the primary sidebar renders as an
 * overlay drawer instead of a fixed column. Backed by matchMedia so it tracks live
 * window resizes, not just the size at mount. */
export function useNarrowLayout(): boolean {
  const [isNarrow, setIsNarrow] = useState(() => window.matchMedia(`(max-width: ${NARROW_LAYOUT_BREAKPOINT_PX}px)`).matches);

  useEffect(() => {
    const mediaQuery = window.matchMedia(`(max-width: ${NARROW_LAYOUT_BREAKPOINT_PX}px)`);
    const handleChange = (event: MediaQueryListEvent) => setIsNarrow(event.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  return isNarrow;
}
