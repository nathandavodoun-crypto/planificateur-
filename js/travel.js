// Trajet retour : après le dernier cours de la journée, il faut un certain
// temps pour rentrer (l'utilisateur rentre ~30 à 40 min après la fin des
// cours). Ce créneau n'est pas saisi à la main : il se déduit de l'emploi du
// temps et du réglage `travelAfterClassMinutes`. Source unique, utilisée par
// le moteur (pour ne rien planifier dedans) ET par les vues (pour l'afficher).

import { timeToMinutes, minutesToTime } from './utils/date.js';
import { constraintAppliesOnDate } from './vacations.js';

/** @returns {{start: string, end: string} | null} le créneau de trajet de ce jour, ou null s'il n'y a pas de cours. */
export function travelBlockForDate(dateISO, weeklyConstraints, settings, vacations = []) {
  const travel = settings.travelAfterClassMinutes || 0;
  if (travel <= 0) return null;

  const courses = weeklyConstraints.filter((c) => c.category === 'cours' && constraintAppliesOnDate(c, dateISO, vacations));
  if (courses.length === 0) return null;

  const lastEnd = courses.map((c) => c.endTime).sort().pop();
  return { start: lastEnd, end: minutesToTime(timeToMinutes(lastEnd) + travel) };
}
