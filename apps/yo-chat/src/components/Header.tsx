import { Link, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { ChevronDown, ArrowUpRight, Command } from "lucide-react";
import { Drawer } from "./Drawer";
import { demos } from "./demo-navigation";

export default function Header() {
  const [open, setOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const current = demos.find((demo) => pathname.replace(/\/$/, "") === demo.to);
  return (
    <>
      <header className="app-header">
        <Link to="/" className="app-brand" aria-label="Yo Chat home">
          <span className="brand-mark">
            <Command size={17} />
          </span>
          yo<span className="brand-dot">.</span>chat
        </Link>
        <span className="header-divider" />
        <button
          className="demo-switcher"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          {current?.label ?? "Explore"}
          <ChevronDown size={14} />
        </button>
      </header>
      <Drawer open={open} onClose={() => setOpen(false)} title="Explore">
        <nav className="demo-nav" aria-label="Demos">
          {demos.map(({ to, label, description, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              onClick={() => setOpen(false)}
              className="demo-nav-item"
              activeProps={{ className: "demo-nav-item selected" }}
            >
              <Icon size={20} />
              <span>
                <strong>{label}</strong>
                <small>{description}</small>
              </span>
              <ArrowUpRight size={15} />
            </Link>
          ))}
          <Link to="/lab/durability" onClick={() => setOpen(false)} className="lab-link">
            Durability lab <ArrowUpRight size={14} />
          </Link>
        </nav>
      </Drawer>
    </>
  );
}
