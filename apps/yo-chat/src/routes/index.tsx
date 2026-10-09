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
        {demos.map(({ to, label, description, icon: Icon }, index) => (
          <Link key={to} to={to} className="demo-card">
            <div>
              <Icon size={24} />
              <span className="demo-number">0{index + 1}</span>
            </div>
            <h2>{label}</h2>
            <p>{description}</p>
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
