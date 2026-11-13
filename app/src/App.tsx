import { HashRouter, Route, Routes } from "react-router";
import { StatusPage } from "./features/status/StatusPage.tsx";

// M0: the only page is the data status. Season, Live and Players arrive in M1 to M3.
export function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="*" element={<StatusPage />} />
      </Routes>
    </HashRouter>
  );
}
