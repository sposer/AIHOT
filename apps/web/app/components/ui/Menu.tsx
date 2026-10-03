import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Presence } from "./Presence";

/** A small dropdown anchored to a trigger; closes on outside click, Escape or choosing an entry. */
export function Menu({ trigger, label, children, align = "right", triggerClassName }: { trigger: ReactNode; label: string; children: (close: () => void) => ReactNode; align?: "left" | "right"; triggerClassName?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const entries = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const items = entries();
    (items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const onKeyDown = (event: KeyboardEvent) => {
    if (open && event.key === " " && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.target instanceof HTMLAnchorElement && event.target.matches('[role^="menuitem"]')) {
      event.preventDefault();
      event.target.click();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    event.preventDefault();
    const items = entries();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[index]?.focus();
  };
  return (
    <div ref={ref} className="relative" onKeyDown={onKeyDown} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`${triggerClassName ?? "inline-flex size-8 items-center justify-center"} rounded-control transition-colors ${open ? "bg-bg-sunk text-ink" : "text-ink-3 hover:bg-bg-sunk hover:text-ink"}`}
      >
        {trigger}
      </button>
      {/* Presence retains its last child during exit; the live boundary disables that child's interaction. */}
      <div inert={!open} aria-hidden={!open || undefined}>
        <Presence show={open} enter="anim-drop-in" exit="anim-drop-out" duration={140}>
          {/* decision: anchor below the trigger; not a fixed offset because supported triggers have different heights. */}
          <div
            role="menu"
            className={`absolute top-full mt-2 z-50 min-w-[168px] overflow-hidden rounded-tile border border-line bg-raised py-1 shadow-[var(--shadow-pop)] ${align === "right" ? "right-0 origin-top-right" : "left-0 origin-top-left"}`}
          >
            {children(close)}
          </div>
        </Presence>
      </div>
    </div>
  );
}

/** One entry of a Menu (a button or a link). */
export function MenuItem({ icon, children, onSelect, href, download }: { icon?: ReactNode; children: ReactNode; onSelect?: () => void; href?: string; download?: boolean }) {
  const cls = "flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-ink-2 transition-colors hover:bg-bg-sunk hover:text-ink";
  const inner = (
    <>
      {icon && <span className="text-ink-4">{icon}</span>}
      {children}
    </>
  );
  if (href) {
    return (
      <a role="menuitem" href={href} download={download} onClick={onSelect} className={cls}>
        {inner}
      </a>
    );
  }
  return (
    <button role="menuitem" type="button" onClick={onSelect} className={cls}>
      {inner}
    </button>
  );
}
