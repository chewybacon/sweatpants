import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";

const ReplyFocus = createContext<{ current: boolean } | null>(null);

/** Follow a reply only while the user remains engaged with the submission. */
export function ReplyFocusProvider({ children }: { children: ReactNode }) {
  const pending = useRef(false);
  useEffect(() => {
    const cancel = (event: Event) => {
      if (event.defaultPrevented) {
        return;
      }
      pending.current = false;
    };
    window.addEventListener("wheel", cancel, { passive: true });
    window.addEventListener("touchstart", cancel, { passive: true });
    window.addEventListener("pointerdown", cancel);
    window.addEventListener("keydown", cancel);
    return () => {
      window.removeEventListener("wheel", cancel);
      window.removeEventListener("touchstart", cancel);
      window.removeEventListener("pointerdown", cancel);
      window.removeEventListener("keydown", cancel);
    };
  }, []);
  return <ReplyFocus.Provider value={pending}>{children}</ReplyFocus.Provider>;
}

export function useReplyFocus(input: RefObject<HTMLTextAreaElement | null>, blocked: boolean) {
  const pending = useContext(ReplyFocus);
  useEffect(() => {
    if (blocked || !pending?.current) {
      return;
    }
    // Let the previous receipt's height transition finish before choosing the scroll target.
    const timer = window.setTimeout(() => {
      const field = input.current;
      if (!pending.current || !field || field.disabled) {
        return;
      }
      pending.current = false;
      const card = field.closest(".ask-card");
      const target =
        card && card.getBoundingClientRect().height < window.innerHeight - 48 ? card : field;
      field.focus({ preventScroll: true });
      target.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
        block: "center",
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [blocked, input, pending]);
  return () => {
    if (pending) {
      pending.current = true;
    }
  };
}
