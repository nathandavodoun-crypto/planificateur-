// Utilitaires date/heure en heure locale de l'appareil ("wall-clock").
//
// Convention utilisée dans toute l'app :
//   - une date est une chaîne "YYYY-MM-DD" (comparable directement avec < > ===
//     car le format est trié lexicographiquement dans le même ordre que le temps)
//   - une heure est une chaîne "HH:MM" (24h)
//   - `new Date(y, m, d, h, mi)` (constructeur à arguments séparés) est TOUJOURS
//     interprété en heure locale par JavaScript, jamais en UTC — c'est ce qu'on
//     veut : la Guyane est UTC-3 toute l'année (pas d'heure d'été), donc l'heure
//     locale de l'appareil est directement la bonne heure "murale" à utiliser.

const JOURS_FR = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** "YYYY-MM-DD" pour la date locale d'un objet Date. */
export function toISODate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Reconstruit un objet Date (heure locale, 00:00) depuis "YYYY-MM-DD". */
export function fromISODate(dateISO) {
  const [y, m, d] = dateISO.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Combine une date ISO et une heure "HH:MM" en un instant local précis. */
export function combineDateTime(dateISO, timeStr) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const { h, min } = splitTime(timeStr);
  return new Date(y, m - 1, d, h, min);
}

function splitTime(timeStr) {
  const [h, min] = timeStr.split(':').map(Number);
  return { h, min };
}

/** Minutes écoulées depuis minuit pour une heure "HH:MM". */
export function timeToMinutes(timeStr) {
  const { h, min } = splitTime(timeStr);
  return h * 60 + min;
}

/** Minutes depuis minuit -> "HH:MM". */
export function minutesToTime(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const min = totalMinutes % 60;
  return `${pad2(h)}:${pad2(min)}`;
}

/** "YYYY-MM-DD" du jour local de `now` (objet Date). */
export function todayISO(now) {
  return toISODate(now);
}

/** Minutes écoulées depuis minuit pour l'instant `now` (objet Date). */
export function nowMinutes(now) {
  return now.getHours() * 60 + now.getMinutes();
}

/** Ajoute `n` jours (peut être négatif) à une date ISO. */
export function addDaysISO(dateISO, n) {
  const d = fromISODate(dateISO);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

/** Différence en jours entiers (a - b), pour deux dates ISO. */
export function diffDaysISO(aISO, bISO) {
  const a = fromISODate(aISO);
  const b = fromISODate(bISO);
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}

/** 0=dimanche ... 6=samedi, comme Date.prototype.getDay(). */
export function weekdayOfISO(dateISO) {
  return fromISODate(dateISO).getDay();
}

export function isWeekendISO(dateISO) {
  const wd = weekdayOfISO(dateISO);
  return wd === 0 || wd === 6;
}

/** Le plus petit/grand élément d'un tableau de dates ISO. */
export function minISO(dates) {
  return dates.reduce((min, d) => (d < min ? d : min));
}
export function maxISO(dates) {
  return dates.reduce((max, d) => (d > max ? d : max));
}

/** Différence en minutes entre deux instants (objets Date). */
export function minutesBetween(fromInstant, toInstant) {
  return (toInstant.getTime() - fromInstant.getTime()) / 60000;
}

/** Arrondit au multiple de 5 le plus proche (plannings plus lisibles). */
export function round5(minutes) {
  return Math.round(minutes / 5) * 5;
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** "lun 28/09" à partir d'une date ISO — pour l'affichage. */
export function formatDateFR(dateISO) {
  const d = fromISODate(dateISO);
  return `${JOURS_FR[d.getDay()]} ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
}

/** Durée en minutes -> "1h30" / "45 min" / "2h" — pour l'affichage. */
export function formatDuration(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const min = totalMinutes % 60;
  if (h === 0) return `${min} min`;
  if (min === 0) return `${h}h`;
  return `${h}h${pad2(min)}`;
}
