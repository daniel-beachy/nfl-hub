import { Notice, PageHeader } from "../../ui/primitives.tsx";

// Placeholder until the Live pages are built (M2 in docs/PLAN.md).
export function LivePage() {
  return (
    <>
      <PageHeader title="Live" note="Follow a game with win probability, EPA and a delay matched to your TV." />
      <Notice title="Not built yet">This area is still to come. The data behind it is already being collected.</Notice>
    </>
  );
}
