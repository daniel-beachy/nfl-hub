import type { ReactNode } from "react";
import { Link, NavLink, Outlet } from "react-router";
import { setPrefs, usePrefs } from "../lib/prefs.ts";
import { LiveIcon, MoonIcon, PlayersIcon, SeasonIcon, SunIcon } from "./icons.tsx";
import { TeamPicker } from "./TeamPicker.tsx";
import { useApplyTheme } from "./theme.ts";
import css from "./Shell.module.css";

// The frame around every page: brand, the three areas, favorite team and theme.
// One nav element, laid out as a top bar from 720 px and a bottom tab bar below it.

const AREAS: { to: string; label: string; icon: ReactNode }[] = [
  { to: "/live", label: "Live", icon: <LiveIcon /> },
  { to: "/season", label: "Season", icon: <SeasonIcon /> },
  { to: "/players", label: "Players", icon: <PlayersIcon /> },
];

const PORTFOLIO_URL = "https://daniel-beachy.github.io/";

function ThemeToggle() {
  const { theme } = usePrefs();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button type="button" className={css.iconButton} onClick={() => setPrefs({ theme: next })} aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}>
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

export function Shell() {
  useApplyTheme();
  return (
    <div className={css.shell}>
      <a href="#main" className={css.skip}>
        Skip to content
      </a>
      <header className={css.topbar}>
        <div className={css.topbarInner}>
          <Link to="/" className={css.brand}>
            <span className={css.brandMark} aria-hidden="true" />
            NFL Hub
          </Link>
          <nav className={css.nav} aria-label="Main">
            {AREAS.map((a) => (
              <NavLink key={a.to} to={a.to} className={({ isActive }) => (isActive ? `${css.navLink} ${css.navLinkActive}` : css.navLink)}>
                <span className={css.navIcon}>{a.icon}</span>
                <span>{a.label}</span>
              </NavLink>
            ))}
          </nav>
          <div className={css.tools}>
            <TeamPicker />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main id="main" className={css.main} tabIndex={-1}>
        <Outlet />
      </main>
      <footer className={css.footer}>
        <Link to="/status">Data status</Link>
        <a href={PORTFOLIO_URL}>More projects</a>
      </footer>
    </div>
  );
}
