import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../auth";

function StartNow({
  className = "btn btn-primary btn-lg",
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const { authenticated } = useAuth();
  return (
    <Link to={authenticated ? "/dashboard" : "/login"} className={className}>
      {children ?? "Start Now"}
    </Link>
  );
}

function FeatureIcon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function LandingNav() {
  const location = useLocation();
  useEffect(() => {
    if (location.hash) {
      const el = document.getElementById(location.hash.slice(1));
      if (el) el.scrollIntoView({ behavior: "smooth" });
    }
  }, [location]);
  return (
    <nav className="landing-nav">
      <div className="landing-nav-inner">
        <Link to="/" className="brand">
          <span className="brand-mark">A</span>
          <span>Aurex</span>
        </Link>
        <div className="landing-links">
          <Link to="/#features">Features</Link>
          <Link to="/#how-it-works">How it works</Link>
          <Link to="/#efficiency">Efficiency</Link>
          <Link to="/#pricing">Pricing</Link>
          <Link to="/#faq">FAQ</Link>
        </div>
        <StartNow className="btn btn-primary btn-sm">Start Now</StartNow>
      </div>
    </nav>
  );
}

function MockConsole() {
  return (
    <div className="mock-console">
      <div className="mock-bar">
        <span className="term-dot red" />
        <span className="term-dot yellow" />
        <span className="term-dot green" />
        <span className="mock-title">Aurex · big-pickle</span>
        <span className="badge running">running</span>
      </div>
      <div className="mock-screen">
        <div className="mock-line">
          <span className="term-prompt">aurex@portal:~$</span> aurex serve --model big-pickle
        </div>
        <div className="mock-line mock-task">
          <span className="term-prompt">aurex@portal:~$</span> Build an event booking app…
        </div>
        <div className="mock-divider" />
        <div className="mock-step">step 1 · scaffold</div>
        <div className="mock-todo done">✓ Read project state</div>
        <div className="mock-todo done">✓ Scaffold Vite + React</div>
        <div className="mock-todo active">● Plan event schema</div>
        <div className="mock-cmd">❯ npm create vite@latest . -- --template react</div>
        <div className="mock-out">✓ Project scaffolded in /workspace/evently</div>
        <div className="mock-tool">
          <span className="mock-tool-name">write</span> src/components/EventCard.jsx
        </div>
        <div className="mock-code">
          <span className="c-key">export default</span>{" "}
          <span className="c-fn">function</span> EventCard({"{ event }"}) {"{"}
          {"\n  "}return <span className="c-tag">&lt;div&gt;</span>{"{"}
          {"\n    "}<span className="c-muted">{"// booking card"}</span>
          {"\n  "}{"}"}<span className="c-tag">&lt;/div&gt;</span>;
          {"\n"}
          {"}"}
        </div>
        <div className="mock-thinking">
          <span className="mock-thinking-label">thinking</span>
          verifying the booking flow against the schema…
        </div>
        <div className="mock-tool">
          <span className="mock-tool-name">bash</span>
        </div>
        <div className="mock-out">✓ Build succeeded in 2.4s</div>
        <div className="mock-cursor">▊</div>
      </div>
      <div className="mock-footer">
        <span className="footer-live">● streaming</span>
        <span>·</span>
        <span className="mono">big-pickle</span>
        <span>·</span>
        <span>132 events</span>
      </div>
    </div>
  );
}

const FEATURES = [
  {
    title: "Private per-user environments",
    desc: "Every account gets its own isolated Linux container. No shared filesystems, no cross-account access — your projects and files are yours alone.",
    d: "M12 3 4 7v6c0 4.4 3.4 7.8 8 9 4.6-1.2 8-4.6 8-9V7l-8-4zM9.5 12l2 2 3.5-3.5",
  },
  {
    title: "Live session console",
    desc: "Every command, file write, and tool call streams to your browser in real time — watch the agent work, no black boxes, no waiting for a summary.",
    d: "M4 5h16v14H4zM4 9h16M8 12h5",
  },
  {
    title: "Autonomous long runs",
    desc: "Give it a job and walk away. Agents plan their work, run tools, and deliver a written result — including multi-step builds that run unattended.",
    d: "M13 3 4 14h6l-1 7 9-11h-6l1-7z",
  },
  {
    title: "Steer it live",
    desc: "Stop a run with one click, answer the agent's questions inline, or message it mid-session to change direction without losing progress.",
    d: "M21 12a9 9 0 1 1-9-9M9 12h12M21 12l-4-4M21 12l-4 4",
  },
  {
    title: "Inspect every change",
    desc: "Browse the workspace like your own IDE — read any file and see exact diffs of what the agent wrote versus what's on disk right now.",
    d: "M4 6h16M4 12h10M4 18h6M14 12l4-2M18 10l4 4-4 2-4-4z",
  },
  {
    title: "Preview & publish",
    desc: "Open a live preview of the running app, iterate with the agent, then publish it to the web — or export the full codebase — in one click.",
    d: "M12 3a9 9 0 1 0 9 9M12 3c2.5 2.6 3.5 5.7 3.5 9s-1 6.4-3.5 9M12 3c-2.5 2.6-3.5 5.7-3.5 9s1 6.4 3.5 9M3.5 9h17M3.5 15h17",
  },
];

const STEPS = [
  {
    n: "01",
    title: "Create a project",
    desc: "One folder inside your private container. Add a name and a one-line description — nothing else to set up.",
  },
  {
    n: "02",
    title: "Describe the task",
    desc: "Type what to build. Pick a model and a stack — frontend, backend, database — and hit start.",
  },
  {
    n: "03",
    title: "Watch it ship",
    desc: "The agent plans, builds, and tests autonomously while you watch live. Preview, iterate, publish.",
  },
];

const EFFICIENCY = [
  {
    title: "Stateful across runs",
    desc: "Each session writes STATE.md and picks up where the last one left off — continue work without re-explaining anything.",
  },
  {
    title: "Parallel tool use",
    desc: "Agents write, edit, and run bash in parallel, so a full-stack build completes in minutes, not days.",
  },
  {
    title: "Zero-setup workspaces",
    desc: "A prebuilt workspace image means no dependency hell, no version drift — every run starts clean and reproducible.",
  },
  {
    title: "Focused by design",
    desc: "A single goal per run keeps the agent on task. Steer or stop it any time instead of burning tokens on a black box.",
  },
];

const TESTIMONIALS = [
  {
    quote: "I described the app, and watched it build the whole thing. It's like hiring a junior engineer who never sleeps.",
    name: "Sofia M.",
    role: "Indie developer",
  },
  {
    quote: "The live console is the killer feature. I see exactly what the agent is doing — every command, every file. No black box.",
    name: "Daniel K.",
    role: "Technical founder",
  },
  {
    quote: "We prototype internal tools in days instead of weeks. The isolated containers make it safe to hand the agent real repos.",
    name: "Amara O.",
    role: "Engineering lead",
  },
];

const FREE_FEATURES = [
  "Private, isolated Linux workspace",
  "Live session console",
  "Autonomous agent runs — up to 30 minutes",
  "File explorer & change diffs",
  "App previews & one-click publishing",
  "Community models & support",
];

const FAQS = [
  {
    q: "Is my workspace private?",
    a: "Yes. Every account gets its own isolated container — there is no shared filesystem, and the API only lets you access your own projects, runs, and files.",
  },
  {
    q: "What can the agents build?",
    a: "Anything that runs on Linux: web apps, APIs, CLI tools, scripts, and integrations. The workspace image ships with Node.js and a standard toolchain, and agents can install what they need inside their container.",
  },
  {
    q: "Can I watch it work?",
    a: "Yes — everything streams live to your browser. You see each command, tool call, file write, and thinking step as it happens.",
  },
  {
    q: "Can I stop or redirect it?",
    a: "Absolutely. Stop any run with one click, answer the agent's questions inline as they come up, or send it a message mid-session to change course.",
  },
  {
    q: "How do I ship what it builds?",
    a: "Open a live preview of the running app, publish it to a public URL in one click, or export the full codebase and take it anywhere.",
  },
  {
    q: "Is there a free tier?",
    a: "Yes — the Starter plan is free forever and includes a live workspace, community models, and everything you need to run your first project.",
  },
];

function Section({
  id,
  eyebrow,
  title,
  sub,
  children,
}: {
  id?: string;
  eyebrow?: string;
  title: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="l-sec">
      <div className="l-sec-head">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h2>{title}</h2>
        {sub && <p className="l-sec-sub">{sub}</p>}
      </div>
      {children}
    </section>
  );
}

export default function Landing() {
  return (
    <div className="landing">
      {/* Nav */}
      <LandingNav />

      {/* Hero */}
      <header className="l-hero">
        <div className="l-hero-inner">
          <div className="l-hero-copy">
            <span className="eyebrow">Autonomous agents · Isolated Linux environments</span>
            <h1>
              Your private <span className="grad">AI workforce</span>, shipping real software.
            </h1>
            <p className="l-hero-sub">
              Aurex gives autonomous agents their own private container where they build, test, and
              deploy your project — streamed live, steered by you, start to finish.
            </p>
            <div className="l-cta">
              <StartNow>Start Now — it's free</StartNow>
              <a href="#how-it-works" className="btn btn-secondary btn-lg">
                See how it works
              </a>
            </div>
            <div className="l-tech">
              <span>Runs any stack</span>
              {["React", "Vite", "Node.js", "Python", "Go", "Docker", "SQLite", "PostgreSQL"].map((t) => (
                <code key={t}>{t}</code>
              ))}
            </div>
          </div>
          <div className="l-hero-visual">
            <MockConsole />
          </div>
        </div>
      </header>

      {/* Features */}
      <Section id="features" eyebrow="Capabilities" title="Everything you need to ship" sub="A complete AI build workflow — environment, execution, inspection, and delivery.">
        <div className="feature-grid">
          {FEATURES.map((f) => (
            <div className="feature-card" key={f.title}>
              <span className="feature-icon">
                <FeatureIcon d={f.d} />
              </span>
              <h3>{f.title}</h3>
              <p>{f.desc}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* How it works */}
      <Section id="how-it-works" eyebrow="Workflow" title="From idea to shipped in three steps">
        <div className="steps">
          {STEPS.map((s) => (
            <div className="step" key={s.n}>
              <span className="step-n">{s.n}</span>
              <h3>{s.title}</h3>
              <p>{s.desc}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* Efficiency */}
      <Section id="efficiency" eyebrow="Efficiency" title="Built for throughput" sub="The difference between an assistant and a workforce is what gets done without you.">
        <div className="efficiency-grid">
          {EFFICIENCY.map((e) => (
            <div className="eff-card" key={e.title}>
              <h3>{e.title}</h3>
              <p>{e.desc}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* Security */}
      <Section eyebrow="Security" title="Isolation by default">
        <div className="security-panel">
          <div className="security-card">
            <h3>One container per account</h3>
            <p>Hard isolation through Docker — no shared state between users, ever.</p>
          </div>
          <div className="security-card">
            <h3>Owner-only access</h3>
            <p>Access is enforced at the API level. No one else can list, read, or modify your work.</p>
          </div>
          <div className="security-card">
            <h3>Your files stay yours</h3>
            <p>Everything lives in your workspace. Export the full codebase at any time.</p>
          </div>
        </div>
      </Section>

      {/* Showcase */}
      <Section eyebrow="See it live" title="A session, as it happens">
        <div className="showcase">
          <MockConsole />
          <div className="showcase-copy">
            <ul>
              <li><span className="sc-mark">✓</span> Streams every command and tool call in real time</li>
              <li><span className="sc-mark">✓</span> Inline questions you answer with one click</li>
              <li><span className="sc-mark">✓</span> File diffs for every change the agent makes</li>
              <li><span className="sc-mark">✓</span> Live app preview while the dev server runs</li>
              <li><span className="sc-mark">✓</span> One-click publish to a public URL</li>
            </ul>
            <StartNow className="btn btn-primary">Try it yourself</StartNow>
          </div>
        </div>
      </Section>

      {/* Testimonials */}
      <Section eyebrow="Loved by builders" title="Teams and makers ship with Aurex">
        <div className="testimonials">
          {TESTIMONIALS.map((t) => (
            <div className="testimonial" key={t.name}>
              <span className="t-quote">“{t.quote}”</span>
              <div className="t-author">
                <span className="avatar-fallback">{t.name[0]}</span>
                <div>
                  <div className="t-name">{t.name}</div>
                  <div className="t-role">{t.role}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* Pricing */}
      <Section id="pricing" eyebrow="Pricing" title="Free forever. No card required." sub="Everything you need to run your first AI project — yours for free.">
        <div className="free-plan">
          <span className="price-tag">Free Forever</span>
          <div className="free-plan-inner">
            <div className="free-plan-main">
              <h3>Aurex</h3>
              <div className="price">
                <span className="price-num">$0</span>
                <span className="price-period">/ forever</span>
              </div>
              <p className="free-plan-blurb">
                Start shipping with your own private AI workspace right now. No credit card, no
                time limit.
              </p>
            </div>
            <ul className="free-plan-features">
              {FREE_FEATURES.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            <StartNow className="btn btn-primary btn-lg">Start Now — it's free</StartNow>
          </div>
        </div>
      </Section>

      {/* FAQ */}
      <Section id="faq" eyebrow="FAQ" title="Questions, answered">
        <div className="faq">
          {FAQS.map((f) => (
            <details className="faq-item" key={f.q}>
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </Section>

      {/* CTA band */}
      <section className="l-cta-band">
        <div className="cta-inner">
          <h2>Give your next project to an AI engineer.</h2>
          <p>Create a project, describe the task, and watch it ship — free to start.</p>
          <StartNow className="btn btn-primary btn-lg">Start Now — it's free</StartNow>
        </div>
      </section>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="footer-grid">
          <div className="footer-brand">
            <span className="brand">
              <span className="brand-mark">A</span>
              <span>Aurex</span>
            </span>
            <p>An AI agent platform that ships real software in private, live-streamed workspaces.</p>
          </div>
          <div className="footer-col">
            <h4>Product</h4>
            <a href="#features">Features</a>
            <a href="#how-it-works">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href="#faq">FAQ</a>
          </div>
          <div className="footer-col">
            <h4>Resources</h4>
            <a href="/dashboard">Dashboard</a>
            <a href="/login">Sign in</a>
          </div>
          <div className="footer-col">
            <h4>Legal</h4>
            <Link to="/privacy">Privacy Policy</Link>
            <Link to="/terms">Terms of Service</Link>
            <a href="#">Security</a>
          </div>
        </div>
        <div className="footer-bottom">
          <span>© {new Date().getFullYear()} Aurex. All rights reserved.</span>
        </div>
      </footer>
    </div>
  );
}
