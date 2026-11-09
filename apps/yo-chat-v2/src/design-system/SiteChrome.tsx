import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { Theme } from "@astryxdesign/core/theme";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Link } from "@astryxdesign/core/Link";
import { createLink } from "@tanstack/react-router";
import { Text } from "@astryxdesign/core/Text";
import { themes, defaultThemeSlug } from "../astryx-themes";

const RouterLink = createLink(Link);

const styles = stylex.create({
  shell: { minHeight: "100vh", backgroundColor: "var(--color-background-body)" },
  container: {
    width: "min(calc(100% - 3rem), 77.5rem)",
    marginInline: "auto",
    "@media (max-width: 720px)": { width: "calc(100% - 1.75rem)" },
  },
  header: { borderBottom: "1px solid var(--color-border)" },
  main: { flexGrow: 1, paddingBlock: "clamp(2rem, 6vw, 4.5rem)" },
  footer: { borderTop: "1px solid var(--color-border)" },
  brand: { fontWeight: 650, letterSpacing: "-0.035em" },
});

export function SiteChrome({ pathname, children }: { pathname: string; children: ReactNode }) {
  return (
    <Theme theme={themes[defaultThemeSlug]} mode="dark">
      <VStack gap={0} xstyle={styles.shell}>
        <HStack
          as="header"
          gap={5}
          justify="between"
          align="center"
          wrap="wrap"
          paddingBlock={4}
          xstyle={[styles.container, styles.header]}
        >
          <RouterLink to="/" label="yo-chat home" xstyle={styles.brand}>
            yo-chat
          </RouterLink>
          <HStack as="nav" aria-label="Main navigation" gap={2}>
            <RouterLink
              to="/chat/cards"
              aria-current={pathname === "/chat/cards" ? "page" : undefined}
            >
              Card chat
            </RouterLink>
            <RouterLink
              to="/examples/tool-rpc"
              aria-current={pathname === "/examples/tool-rpc" ? "page" : undefined}
            >
              Standalone picker
            </RouterLink>
          </HStack>
        </HStack>
        <VStack as="main" xstyle={[styles.container, styles.main]}>
          {children}
        </VStack>
        <HStack
          as="footer"
          gap={4}
          justify="between"
          wrap="wrap"
          paddingBlock={4}
          xstyle={[styles.container, styles.footer]}
        >
          <Text color="secondary">Durable workflows. Disposable computation.</Text>
          <Text color="secondary">TanStack Start</Text>
        </HStack>
      </VStack>
    </Theme>
  );
}
