import { Notice, PageHeader } from "../../ui/primitives.tsx";

// Placeholder until the Players pages are built (M3 in docs/PLAN.md).
export function PlayersPage() {
  return (
    <>
      <PageHeader title="Players" note="Quarterback, running back and receiver analytics with field charts." />
      <Notice title="Not built yet">This area is still to come. The data behind it is already being collected.</Notice>
    </>
  );
}
