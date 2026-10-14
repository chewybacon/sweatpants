import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { DesignSystemRoot } from "./primitives.tsx";
import { tokens } from "./tokens.stylex.ts";

const nav = [
  { href: "/playground", label: "Playground" },
  { href: "/threads", label: "Threads" },
  { href: "/explain/quickjs", label: "QuickJS" },
];

const styles = stylex.create({
  shell: {
    minHeight: "100vh",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gridTemplateRows: "auto 1fr auto",
  },
  ambientLayer: {
    position: "fixed",
    inset: 0,
    overflow: "hidden",
    pointerEvents: "none",
  },
  container: {
    minWidth: 0,
    width: "min(calc(100% - 48px), 1240px)",
    marginInline: "auto",
    "@media (max-width: 720px)": { width: "min(calc(100% - 28px), 1240px)" },
  },
  diagramContainer: {
    width: "min(calc(100% - 48px), 1560px)",
    "@media (max-width: 720px)": { width: "calc(100% - 28px)" },
  },
  ambientTop: {
    position: "absolute",
    zIndex: 0,
    top: "-240px",
    left: "50%",
    width: "720px",
    height: "520px",
    borderRadius: "50%",
    backgroundImage: "radial-gradient(circle, rgba(196, 167, 231, 0.13), transparent 68%)",
    pointerEvents: "none",
    transform: "translateX(-50%)",
  },
  ambientSide: {
    position: "absolute",
    zIndex: 0,
    right: "-260px",
    bottom: "-250px",
    width: "620px",
    height: "620px",
    borderRadius: "50%",
    backgroundImage: "radial-gradient(circle, rgba(49, 116, 143, 0.13), transparent 68%)",
    pointerEvents: "none",
  },
  header: {
    position: "relative",
    zIndex: 5,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.space5,
    paddingBlock: tokens.space4,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: tokens.colorBorder,
    "@media (max-width: 720px)": {
      alignItems: "flex-start",
      flexDirection: "column",
      gap: tokens.space3,
    },
  },
  brand: {
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.space3,
    color: tokens.colorText,
    fontFamily: tokens.fontDisplay,
    fontSize: "1.2rem",
    fontWeight: 650,
    letterSpacing: "-0.035em",
    textDecoration: "none",
  },
  brandMark: {
    width: "34px",
    height: "34px",
    display: "grid",
    placeItems: "center",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.colorPrimary,
    borderRadius: tokens.radiusMedium,
    backgroundColor: tokens.colorPrimaryContainer,
    color: tokens.colorPrimaryText,
    fontFamily: tokens.fontBody,
    fontSize: "0.9rem",
    fontWeight: 800,
    boxShadow: tokens.shadowLow,
  },
  nav: {
    minWidth: 0,
    maxWidth: "100%",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: tokens.space1,
    padding: tokens.space1,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.colorBorder,
    borderRadius: tokens.radiusMedium,
    backgroundColor: tokens.colorSurfaceOverlay,
    "@media (max-width: 720px)": { width: "100%" },
  },
  navLink: {
    flexShrink: 0,
    borderRadius: tokens.radiusSmall,
    paddingBlock: tokens.space2,
    paddingInline: tokens.space3,
    color: tokens.colorTextMuted,
    fontSize: "0.78rem",
    fontWeight: 650,
    textDecoration: "none",
    "@media (max-width: 720px)": { flexGrow: 1, textAlign: "center" },
    transitionProperty: "background-color, color",
    transitionDuration: "150ms",
    ":hover": { backgroundColor: tokens.colorOverlayHover, color: tokens.colorText },
    ":focus-visible": {
      outlineWidth: "2px",
      outlineStyle: "solid",
      outlineColor: tokens.colorFocus,
      outlineOffset: "2px",
    },
  },
  navActive: {
    backgroundColor: tokens.colorPrimaryContainer,
    color: tokens.colorPrimaryText,
  },
  main: {
    position: "relative",
    zIndex: 1,
    paddingBlock: "clamp(32px, 6vw, 72px)",
  },
  footer: {
    position: "relative",
    zIndex: 1,
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: tokens.space4,
    paddingBlock: tokens.space4,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: tokens.colorBorder,
    color: tokens.colorTextMuted,
    fontSize: "0.72rem",
    "@media (max-width: 720px)": {
      flexDirection: "column",
    },
  },
  diagramMain: {
    paddingBlock: "36px",
  },
});

function isActive(pathname: string, href: string) {
  if (href === "/playground" && /^\/threads\/.+/.test(pathname)) {
    return true;
  }
  if (href === "/threads") {
    return pathname === href;
  }
  return pathname === href || (href !== "/" && pathname.startsWith(href));
}

export function SiteChrome({
  pathname,
  children,
  modelLabel = "yo-tisyn",
}: {
  pathname: string;
  children: ReactNode;
  modelLabel?: string;
}) {
  const diagramContainer = pathname === "/explain/quickjs" && styles.diagramContainer;
  return (
    <DesignSystemRoot>
      <div {...stylex.props(styles.shell)}>
        <div {...stylex.props(styles.ambientLayer)} aria-hidden="true">
          <span {...stylex.props(styles.ambientTop)} />
          <span {...stylex.props(styles.ambientSide)} />
        </div>
        <header {...stylex.props(styles.container, diagramContainer, styles.header)}>
          <a {...stylex.props(styles.brand)} href="/playground" aria-label="yo-tisyn playground">
            <span {...stylex.props(styles.brandMark)} aria-hidden="true">
              y
            </span>
            <span>yo-tisyn</span>
          </a>
          <nav {...stylex.props(styles.nav)} aria-label="Main navigation">
            {nav.map((item) => (
              <a
                key={item.href}
                {...stylex.props(styles.navLink, isActive(pathname, item.href) && styles.navActive)}
                href={item.href}
                aria-current={isActive(pathname, item.href) ? "page" : undefined}
              >
                {item.label}
              </a>
            ))}
          </nav>
        </header>
        <main
          {...stylex.props(
            styles.container,
            diagramContainer,
            styles.main,
            pathname === "/explain/quickjs" && styles.diagramMain,
          )}
        >
          {children}
        </main>
        <footer {...stylex.props(styles.container, diagramContainer, styles.footer)}>
          <span>Durable workflows. Disposable computation.</span>
          <span>{modelLabel}</span>
        </footer>
      </div>
    </DesignSystemRoot>
  );
}
