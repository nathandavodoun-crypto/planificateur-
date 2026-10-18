// Vacances et jours de repos : logique pure, partagée par le moteur, les vues
// et les notifications pour qu'ils parlent tous de la même journée.

import { weekdayOfISO } from './utils/date.js';

/** La période de vacances qui couvre cette date, ou null. */
export function vacationForDate(dateISO, vacations) {
  return (vacations || []).find((v) => v.startDate && v.endDate && dateISO >= v.startDate && dateISO <= v.endDate) || null;
}

/**
 * Une contrainte hebdomadaire s'applique-t-elle ce jour-là ? Les cours sont
 * suspendus pendant les vacances ; le reste (repas, sport, "pas de travail"…)
 * continue de s'appliquer.
 */
export function constraintAppliesOnDate(c, dateISO, vacations) {
  if (!c.active) return false;
  if (!c.daysOfWeek.includes(weekdayOfISO(dateISO))) return false;
  if (c.effectiveFrom && dateISO < c.effectiveFrom) return false;
  if (c.effectiveUntil && dateISO > c.effectiveUntil) return false;
  if (c.category === 'cours' && vacationForDate(dateISO, vacations)) return false;
  return true;
}

/** Dates des jours de repos (événements "repos" : journée entière bloquée). */
export function restDates(oneOffEvents) {
  return new Set((oneOffEvents || []).filter((e) => e.category === 'repos').map((e) => e.date));
}
