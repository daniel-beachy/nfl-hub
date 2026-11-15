import { HashRouter, Navigate, Route, Routes } from "react-router";
import { LivePage } from "./features/live/LivePage.tsx";
import { PlayersPage } from "./features/players/PlayersPage.tsx";
import { SeasonPage } from "./features/season/SeasonPage.tsx";
import { StatusPage } from "./features/status/StatusPage.tsx";
import { StyleguidePage } from "./features/styleguide/StyleguidePage.tsx";
import { Shell } from "./ui/Shell.tsx";

// Hash routing, so any URL reloads on GitHub Pages without a 404 trick.
// Each area owns everything under its path ("/season/*"); add its sub-routes inside it.
export function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<Navigate to="/season" replace />} />
          <Route path="live/*" element={<LivePage />} />
          <Route path="season/*" element={<SeasonPage />} />
          <Route path="players/*" element={<PlayersPage />} />
          <Route path="status" element={<StatusPage />} />
          <Route path="styleguide" element={<StyleguidePage />} />
          <Route path="*" element={<Navigate to="/season" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
