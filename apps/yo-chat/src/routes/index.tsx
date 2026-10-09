import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { demos } from "@/components/demo-navigation";

export const Route = createFileRoute("/")({ component: App });

function App() {
  return (
    <main className="home-page">
      <p className="eyebrow">THE PLAYGROUND</p>
      <h1>
        A conversation.
        <br />A little more possibility.
      </h1>
      <p className="home-intro">
        Chat, play, and try things out. These conversations have a memory—come back whenever you
        like.
      </p>
      <div className="demo-grid">
        {demos.map(({ to, label, description, icon: Icon }) => (
          <Link key={to} to={to} className="demo-card">
            <span className="demo-icon">
              <Icon size={22} aria-hidden="true" />
            </span>
            <div className="demo-copy">
              <h2>{label}</h2>
              <p>{description}</p>
            </div>
            <ArrowUpRight className="demo-arrow" size={19} />
          </Link>
        ))}
      </div>
      <footer>
        Built with Sweatpants <span>Conversations that keep their place.</span>
      </footer>
    </main>
  );
}
