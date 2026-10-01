// Petites statistiques dérivées de l'historique des sessions — fonctions
// pures, pas d'effet de bord, pas d'accès au DOM (même esprit que
// scheduler.js).

import { todayISO, addDaysISO, minISO } from './utils/date.js';

/** true = toutes les sessions de ce jour sont terminées, false = au moins une ne l'est pas, null = rien de prévu ce jour-là. */
function dayFullyDone(sessions, dateISO) {
  const daySessions = sessions.filter((s) => s.date === dateISO);
  if (daySessions.length === 0) return null;
  return daySessions.every((s) => s.status === 'terminee');
}

/**
 * Nombre de jours consécutifs (en remontant depuis aujourd'hui) où toutes
 * les sessions prévues ont été faites. Un jour sans aucune session prévue
 * est neutre : il ne casse pas le streak, mais ne l'avance pas non plus.
 * Aujourd'hui ne compte que s'il est déjà entièrement terminé ; sinon on
 * part d'hier sans pour autant casser le streak en cours de journée.
 */
export function computeStreak(state, now) {
  const { sessions } = state;
  if (sessions.length === 0) return 0;

  const todayIso = todayISO(now);
  const earliest = minISO(sessions.map((s) => s.date));

  let streak = 0;
  let cursor = todayIso;

  const todayStatus = dayFullyDone(sessions, todayIso);
  if (todayStatus === true) {
    streak++;
    cursor = addDaysISO(cursor, -1);
  } else {
    // Pas encore terminé (ou rien aujourd'hui) : on ne casse rien, on
    // commence simplement le décompte à partir d'hier.
    cursor = addDaysISO(cursor, -1);
  }

  while (cursor >= earliest) {
    const status = dayFullyDone(sessions, cursor);
    if (status === true) {
      streak++;
    } else if (status === false) {
      break; // un jour raté arrête le streak ici
    }
    // status === null (rien de prévu) : neutre, on continue de remonter.
    cursor = addDaysISO(cursor, -1);
  }

  return streak;
}

/** Minutes travaillées (sessions terminées) entre deux dates ISO incluses. */
export function minutesWorkedBetween(state, startISO, endISO) {
  return state.sessions
    .filter((s) => s.status === 'terminee' && s.date >= startISO && s.date <= endISO)
    .reduce((sum, s) => sum + s.durationMinutes, 0);
}
