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

/**
 * Bilan d'une période de vacances (en cours ou terminée) : temps travaillé,
 * chapitres révisés, rattrapage restant et devoirs avancés pour la reprise.
 */
export function vacationReport(state, vacation, now) {
  const today = todayISO(now);
  const { startDate: start, endDate: end } = vacation;
  const status = today < start ? 'a_venir' : today > end ? 'terminee' : 'en_cours';
  const inRange = (d) => d >= start && d <= end;

  const sessions = state.sessions.filter((s) => inRange(s.date));
  const done = sessions.filter((s) => s.status === 'terminee');
  const minutesDone = done.reduce((sum, s) => sum + s.durationMinutes, 0);
  const minutesPlanned = sessions.filter((s) => s.status === 'planifiee' && s.date >= today).reduce((sum, s) => sum + s.durationMinutes, 0);
  const workedDays = new Set(done.map((s) => s.date)).size;

  let chapterReviews = 0;
  for (const ch of state.chapters || []) chapterReviews += (ch.history || []).filter((h) => inRange(h.date)).length;
  const chaptersStillLate = (state.chapters || []).filter((ch) => ch.status === 'active' && ch.nextReviewDate && ch.nextReviewDate <= today).length;

  const restDays = (state.oneOffEvents || []).filter((e) => e.category === 'repos' && inRange(e.date)).length;

  // Devoirs dus juste après la reprise : combien sont déjà finis ?
  const aheadLimit = addDaysISO(end, vacation.aheadDays ?? 7);
  const aheadTasks = (state.tasks || []).filter(
    (t) => ['dm', 'exercices', 'lecture', 'autre'].includes(t.type) && !t.linkedEventId && t.deadlineDate > end && t.deadlineDate <= aheadLimit
  );
  const doneMinutesOf = (t) => state.sessions.filter((s) => s.taskId === t.id && s.status === 'terminee').reduce((sum, s) => sum + s.durationMinutes, 0);
  const aheadFinished = aheadTasks.filter((t) => t.status === 'termine' || doneMinutesOf(t) >= t.estimatedDurationMinutes).length;
  const aheadRemainingMinutes = aheadTasks.reduce((sum, t) => sum + (t.status === 'termine' ? 0 : Math.max(0, t.estimatedDurationMinutes - doneMinutesOf(t))), 0);

  return {
    status,
    totalDays: diffDays(start, end) + 1,
    workedDays,
    sessionsDone: done.length,
    minutesDone,
    minutesPlanned,
    chapterReviews,
    chaptersStillLate,
    restDays,
    ahead: { total: aheadTasks.length, finished: aheadFinished, remainingMinutes: aheadRemainingMinutes },
  };
}

function diffDays(a, b) {
  return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
}
