import stylesheet from "../style.css?url";
import { SiteChrome } from "../design-system/SiteChrome";
import { HeadContent, Scripts, createRootRoute, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Yo Chat" },
    ],
    // Explicit CSS URLs are render-blocking in dev as well as production.
    // Start 1.149’s dev CSS collector truncates quoted Astryx CSS.
    links: [
      { rel: "stylesheet", href: stylesheet },
      // Start does not forward StyleX’s transformIndexHtml stylesheet link.
      ...(import.meta.env.DEV ? [{ rel: "stylesheet", href: "/virtual:stylex.css" }] : []),
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <html lang="en" data-theme="dark" data-astryx-theme="rose-pine">
      <head>
        <HeadContent />
      </head>
      <body>
        <SiteChrome pathname={pathname}>{children}</SiteChrome>
        <Scripts />
      </body>
    </html>
  );
}
