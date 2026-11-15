import { useRef } from "react";
import { CONFERENCES, DIVISION_NAMES } from "../../../shared/ids.ts";
import { getTeam, teamsInDivision, type TeamId } from "../../../shared/teams.ts";
import { setPrefs, usePrefs } from "../lib/prefs.ts";
import { teamColor } from "./theme.ts";
import css from "./TeamPicker.module.css";

// Favorite team: a header button that opens a native <dialog> (focus trap, Escape and
// backdrop come from the browser). The team is emphasized on every chart.

export function TeamPicker() {
  const { favoriteTeam, theme } = usePrefs();
  const dialog = useRef<HTMLDialogElement>(null);
  const team = favoriteTeam ? getTeam(favoriteTeam) : null;

  const choose = (id: TeamId | null) => {
    setPrefs({ favoriteTeam: id });
    dialog.current?.close();
  };

  return (
    <>
      <button type="button" className={css.trigger} onClick={() => dialog.current?.showModal()} aria-haspopup="dialog">
        <span className={css.swatch} style={team ? { background: teamColor(team.id, theme) } : undefined} aria-hidden="true" />
        <span>{team ? team.id : "My team"}</span>
        <span className="visually-hidden">{team ? `Favorite team: ${team.name}. Change` : "Choose a favorite team"}</span>
      </button>
      <dialog
        ref={dialog}
        className={css.dialog}
        aria-label="Favorite team"
        // A click on the backdrop lands on the dialog element itself.
        onClick={(e) => e.target === e.currentTarget && dialog.current?.close()}
      >
        <div className={css.panel}>
          <div className={css.head}>
            <h2>Favorite team</h2>
            <button type="button" className={css.close} onClick={() => dialog.current?.close()} aria-label="Close">
              ✕
            </button>
          </div>
          <p className={css.hint}>Highlighted on every chart. Saved in this browser only.</p>
          <div className={css.conferences}>
            {CONFERENCES.map((conf) => (
              <section key={conf} aria-label={conf}>
                <h3 className={css.conf}>{conf}</h3>
                {DIVISION_NAMES.map((div) => (
                  <div key={div} className={css.division}>
                    <span className={css.divName}>{div}</span>
                    <div className={css.teams}>
                      {teamsInDivision(`${conf} ${div}`).map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          className={css.team}
                          aria-pressed={t.id === favoriteTeam}
                          title={t.name}
                          onClick={() => choose(t.id)}
                        >
                          <span className={css.swatch} style={{ background: teamColor(t.id, theme) }} aria-hidden="true" />
                          <span aria-hidden="true">{t.id}</span>
                          <span className="visually-hidden">{t.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </section>
            ))}
          </div>
          {favoriteTeam && (
            <button type="button" className={css.clear} onClick={() => choose(null)}>
              No favorite team
            </button>
          )}
        </div>
      </dialog>
    </>
  );
}
