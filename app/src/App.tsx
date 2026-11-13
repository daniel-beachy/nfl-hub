import { HashRouter, Route, Routes } from "react-router";
import { SOURCE_IDS } from "../../shared/ids.ts";

function Shell() {
  return (
    <main>
      <h1>NFL Hub</h1>
      <p>Foundation build. No data yet.</p>
      <p>Planned sources: {SOURCE_IDS.join(", ")}</p>
    </main>
  );
}

export function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="*" element={<Shell />} />
      </Routes>
    </HashRouter>
  );
}
