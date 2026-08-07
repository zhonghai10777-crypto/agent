import type { RefObject } from "react";
import { useI18n } from "./i18n/I18nProvider";

interface ThreadSearchBarProps {
  readonly query: string;
  readonly matchCount: number;
  readonly activeIndex: number;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onSearch: (query: string) => void;
  readonly onNext: () => void;
  readonly onPrev: () => void;
  readonly onClose: () => void;
}

export function ThreadSearchBar({
  query,
  matchCount,
  activeIndex,
  inputRef,
  onSearch,
  onNext,
  onPrev,
  onClose,
}: ThreadSearchBarProps) {
  const { t } = useI18n();
  return (
    <div className="thread-search-bar" data-testid="thread-search-bar">
      <input
        ref={inputRef}
        className="thread-search-bar__input"
        type="text"
        placeholder={t("search.placeholder")}
        value={query}
        onChange={(e) => onSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) {
              onPrev();
            } else {
              onNext();
            }
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="thread-search-bar__count">
        {query ? (matchCount > 0 ? `${activeIndex + 1} / ${matchCount}` : t("search.results", { count: 0 })) : ""}
      </span>
      <div className="thread-search-bar__actions">
        <button
          aria-label={t("search.previous")}
          className="icon-button"
          type="button"
          disabled={matchCount === 0}
          onClick={onPrev}
        >
          &#x25B2;
        </button>
        <button
          aria-label={t("search.next")}
          className="icon-button"
          type="button"
          disabled={matchCount === 0}
          onClick={onNext}
        >
          &#x25BC;
        </button>
        <button
          aria-label={t("search.close")}
          className="icon-button"
          type="button"
          onClick={onClose}
        >
          &#x2715;
        </button>
      </div>
    </div>
  );
}
