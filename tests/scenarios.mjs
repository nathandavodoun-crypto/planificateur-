// Scénarios concrets pour valider le moteur de planification, SANS interface
// ni stockage. Exécuter avec :  node tests/scenarios.mjs
//
// Chaque scénario construit des données à la main (cours, sport, tâches),
// appelle recomputeSchedule, affiche le planning jour par jour en clair, puis
// fait tourner des vérifications automatiques (chevauchements, couvre-feu,
// durée max, pauses...) qui affichent ✓ ou ✗.

import { recomputeSchedule } from '../js/scheduler.js';
import {
  defaultSettings,
  createTask,
  createWeeklyConstraint,
  createOneOffEvent,
  createSession,
  DEFAULT_SUBJECTS,
} from '../js/models.js';
import { timeToMinutes, addDaysISO, formatDateFR, formatDuration } from '../js/utils/date.js';

let totalChecks = 0;
let failedChecks = 0;

// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------

const CATEGORY_LABELS = {
  cours: 'Cours',
  sport: 'Sport',
  repas: 'Repas',
  trajet: 'Trajet',
  autre: 'Autre',
  ds: 'DS',
  colle: 'Colle',
  adhoc: 'Imprévu',
};

function subjectLabel(subjectId, settings) {
  const s = (settings.subjects || DEFAULT_SUBJECTS).find((s) => s.id === subjectId);
  return s ? s.label : subjectId;
}

function dayEntries(dateISO, sessions, weeklyConstraints, oneOffEvents, tasksById, settings) {
  const weekday = new Date(dateISO + 'T00:00:00').getDay();
  const entries = [];

  for (const c of weeklyConstraints) {
    if (c.active && c.daysOfWeek.includes(weekday)) {
      entries.push({ start: c.startTime, end: c.endTime, label: `[${CATEGORY_LABELS[c.category]}]`.padEnd(15) + c.label });
    }
  }
  for (const ev of oneOffEvents) {
    if (ev.date === dateISO) {
      entries.push({ start: ev.startTime, end: ev.endTime, label: `[${CATEGORY_LABELS[ev.category]}]`.padEnd(15) + ev.label });
    }
  }
  for (const s of sessions) {
    if (s.date === dateISO) {
      const task = tasksById.get(s.taskId);
      const subj = task ? subjectLabel(task.subject, settings) : '?';
      const title = task ? task.title : s.taskId;
      entries.push({ start: s.startTime, end: s.endTime, label: `[Session]`.padEnd(15) + `${subj} — ${title} (${s.status})` });
    }
  }
  entries.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return entries;
}

function printSchedule(title, { sessions, warnings }, tasksById, weeklyConstraints, oneOffEvents, settings, rangeStartISO, rangeEndISO) {
  console.log(`\n=== ${title} ===`);
  let d = rangeStartISO;
  while (d <= rangeEndISO) {
    const entries = dayEntries(d, sessions, weeklyConstraints, oneOffEvents, tasksById, settings);
    if (entries.length > 0) {
      console.log(formatDateFR(d));
      for (const e of entries) console.log(`  ${e.start}–${e.end}  ${e.label}`);
    }
    d = addDaysISO(d, 1);
  }
  if (warnings.length > 0) {
    console.log('⚠ Avertissements :');
    for (const w of warnings) console.log(`  - ${w.message}`);
  } else {
    console.log('(aucun avertissement)');
  }
}

// ---------------------------------------------------------------------------
// Vérifications automatiques
// ---------------------------------------------------------------------------

function check(label, pass) {
  totalChecks++;
  if (!pass) failedChecks++;
  console.log(`  ${pass ? '✓' : '✗'} ${label}`);
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function blocksForDate(dateISO, weeklyConstraints, oneOffEvents) {
  const weekday = new Date(dateISO + 'T00:00:00').getDay();
  const blocks = [];
  for (const c of weeklyConstraints) {
    if (c.active && c.daysOfWeek.includes(weekday)) blocks.push([timeToMinutes(c.startTime), timeToMinutes(c.endTime)]);
  }
  for (const ev of oneOffEvents) {
    if (ev.date === dateISO) blocks.push([timeToMinutes(ev.startTime), timeToMinutes(ev.endTime)]);
  }
  return blocks;
}

function runStandardChecks(sessions, settings, weeklyConstraints, oneOffEvents) {
  const planned = sessions.filter((s) => s.status !== 'non_faite');
  const byDate = new Map();
  for (const s of planned) {
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date).push(s);
  }

  let noOverlap = true;
  let noAfterCutoff = true;
  let noInBlockedSlot = true;
  let maxLenOk = true;
  let breakOk = true;

  const cutoffMinutes = timeToMinutes(settings.dayEndCutoff);

  for (const [dateISO, daySessions] of byDate) {
    const sorted = [...daySessions].sort((a, b) => (a.startTime < b.startTime ? -1 : 1));
    const blocks = blocksForDate(dateISO, weeklyConstraints, oneOffEvents);

    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i];
      const sStart = timeToMinutes(s.startTime);
      const sEnd = timeToMinutes(s.endTime);

      if (sEnd > cutoffMinutes) noAfterCutoff = false;
      if (sEnd - sStart > settings.maxSessionLengthMinutes) maxLenOk = false;
      for (const [bs, be] of blocks) {
        if (overlaps(sStart, sEnd, bs, be)) noInBlockedSlot = false;
      }
      if (i > 0) {
        const prev = sorted[i - 1];
        const prevEnd = timeToMinutes(prev.endTime);
        if (overlaps(timeToMinutes(prev.startTime), prevEnd, sStart, sEnd)) noOverlap = false;
        else if (sStart - prevEnd < settings.breakDurationMinutes) breakOk = false;
      }
    }
  }

  check('Aucun chevauchement entre sessions', noOverlap);
  check(`Aucune session après ${settings.dayEndCutoff}`, noAfterCutoff);
  check('Aucune session dans un créneau bloqué (cours/colle/DS/imprévu)', noInBlockedSlot);
  check(`Toutes les sessions ≤ ${settings.maxSessionLengthMinutes} min`, maxLenOk);
  check(`Une pause ≥ ${settings.breakDurationMinutes} min est respectée entre sessions du même jour`, breakOk);
}

// ---------------------------------------------------------------------------
// Fixtures communes
// ---------------------------------------------------------------------------

function baseConstraints() {
  return [
    createWeeklyConstraint({ label: 'Cours (matin)', category: 'cours', daysOfWeek: [1, 2, 3, 4, 5], startTime: '08:00', endTime: '12:00' }),
    createWeeklyConstraint({ label: 'Cours (après-midi)', category: 'cours', daysOfWeek: [1, 2, 3, 4, 5], startTime: '13:30', endTime: '16:30' }),
    createWeeklyConstraint({ label: 'Musculation', category: 'sport', daysOfWeek: [1, 3, 5], startTime: '18:00', endTime: '19:30' }),
  ];
}

// Date de référence arbitraire pour des tests reproductibles (peu importe le
// vrai jour de la semaine : le moteur applique les contraintes récurrentes
// selon le jour de semaine réel de chaque date, quel que soit le point de
// départ choisi ici).
const REF_DATE = '2026-09-28';

// ---------------------------------------------------------------------------
// Scénario A — Semaine chargée
// ---------------------------------------------------------------------------

function scenarioA() {
  const now = new Date(2026, 8, 28, 7, 0);
  const settings = defaultSettings();
  const weeklyConstraints = baseConstraints();
  const oneOffEvents = [];

  const tasks = [
    createTask({ subject: 'maths', type: 'dm', title: 'DM intégrales', deadlineDate: addDaysISO(REF_DATE, 4), deadlineTime: '20:00', estimatedDurationMinutes: 180, priority: 2 }),
    createTask({ subject: 'physique', type: 'dm', title: 'DM circuits RC', deadlineDate: addDaysISO(REF_DATE, 5), deadlineTime: '20:00', estimatedDurationMinutes: 150, priority: 2 }),
    createTask({ subject: 'chimie', type: 'exercices', title: 'Exercices cinétique', deadlineDate: addDaysISO(REF_DATE, 3), deadlineTime: '18:00', estimatedDurationMinutes: 60, priority: 2 }),
    createTask({ subject: 'anglais', type: 'lecture', title: 'Lecture article', deadlineDate: addDaysISO(REF_DATE, 1), deadlineTime: '12:00', estimatedDurationMinutes: 45, priority: 1 }),
  ];

  const data = { tasks, sessions: [], weeklyConstraints, oneOffEvents, settings };
  const result = recomputeSchedule(now, data);
  const tasksById = new Map(tasks.map((t) => [t.id, t]));

  printSchedule('Scénario A : Semaine chargée', result, tasksById, weeklyConstraints, oneOffEvents, settings, REF_DATE, addDaysISO(REF_DATE, 6));

  console.log('Vérifications :');
  runStandardChecks(result.sessions, settings, weeklyConstraints, oneOffEvents);

  const planned = result.sessions.filter((s) => s.status === 'planifiee');
  const distinctDays = new Set(planned.map((s) => s.date));
  check('Le travail est réparti sur au moins 3 jours différents', distinctDays.size >= 3);
  check("Aucun avertissement (la semaine tient dans les disponibilités)", result.warnings.length === 0);

  // Alternance de matière : parmi les jours ayant ≥2 sessions, au moins un
  // jour montre des matières différentes entre sessions consécutives.
  let sawAlternation = false;
  for (const day of distinctDays) {
    const daySessions = planned.filter((s) => s.date === day).sort((a, b) => (a.startTime < b.startTime ? -1 : 1));
    for (let i = 1; i < daySessions.length; i++) {
      const subjA = tasksById.get(daySessions[i - 1].taskId).subject;
      const subjB = tasksById.get(daySessions[i].taskId).subject;
      if (subjA !== subjB) sawAlternation = true;
    }
  }
  check('Alternance de matière observée au moins une fois quand possible', sawAlternation || planned.length < 2);
}

// ---------------------------------------------------------------------------
// Scénario B — DS + DM la même semaine
// ---------------------------------------------------------------------------

function scenarioB() {
  const now = new Date(2026, 8, 28, 7, 0);
  const settings = defaultSettings();
  const weeklyConstraints = baseConstraints();

  const dsDate = addDaysISO(REF_DATE, 8); // vendredi suivant, largement à l'avance
  const oneOffEvents = [createOneOffEvent({ label: 'DS de Maths', category: 'ds', date: dsDate, startTime: '14:00', endTime: '17:00', subject: 'maths' })];

  const tasks = [
    createTask({ subject: 'maths', type: 'revision_ds', title: 'Révision DS Maths', deadlineDate: dsDate, deadlineTime: '14:00', estimatedDurationMinutes: 180, priority: 3 }),
    createTask({ subject: 'physique', type: 'dm', title: 'DM ondes', deadlineDate: dsDate, deadlineTime: '20:00', estimatedDurationMinutes: 120, priority: 2 }),
  ];

  const data = { tasks, sessions: [], weeklyConstraints, oneOffEvents, settings };
  const result = recomputeSchedule(now, data);
  const tasksById = new Map(tasks.map((t) => [t.id, t]));

  printSchedule('Scénario B : DS + DM la même semaine', result, tasksById, weeklyConstraints, oneOffEvents, settings, REF_DATE, addDaysISO(dsDate, 1));

  console.log('Vérifications :');
  runStandardChecks(result.sessions, settings, weeklyConstraints, oneOffEvents);

  const revisionTask = tasks[0];
  const revisionSessions = result.sessions.filter((s) => s.taskId === revisionTask.id);
  const revisionDays = new Set(revisionSessions.map((s) => s.date));

  check('La révision de DS est découpée en plusieurs sessions', revisionSessions.length >= 2);
  check('Les sessions de révision sont réparties sur au moins 2 jours distincts', revisionDays.size >= 2);
  check("Aucune session de révision ne tombe dans le créneau du DS lui-même", revisionSessions.every((s) => s.date !== dsDate || timeToMinutes(s.endTime) <= timeToMinutes('14:00')));

  const dmTask = tasks[1];
  const dmSessions = result.sessions.filter((s) => s.taskId === dmTask.id);
  let noCollision = true;
  for (const dm of dmSessions) {
    for (const rev of revisionSessions) {
      if (dm.date === rev.date && overlaps(timeToMinutes(dm.startTime), timeToMinutes(dm.endTime), timeToMinutes(rev.startTime), timeToMinutes(rev.endTime))) {
        noCollision = false;
      }
    }
  }
  check('Aucune collision entre les sessions du DM et celles de révision', noCollision);

  const lastRevisionDay = [...revisionDays].sort().pop();
  check("La dernière session de révision n'est pas forcément la veille au soir du DS (marge de sécurité respectée)", lastRevisionDay < dsDate);
}

// ---------------------------------------------------------------------------
// Scénario C — Session manquée -> replanification
// ---------------------------------------------------------------------------

function scenarioC() {
  const settings = defaultSettings();
  const weeklyConstraints = baseConstraints();
  const oneOffEvents = [];

  const task = createTask({
    subject: 'si',
    type: 'dm',
    title: 'DM asservissements',
    deadlineDate: addDaysISO(REF_DATE, 5),
    deadlineTime: '20:00',
    estimatedDurationMinutes: 120,
    priority: 2,
  });

  // --- Étape 1 : premier calcul, lundi matin --------------------------------
  const now1 = new Date(2026, 8, 28, 7, 0);
  const data1 = { tasks: [task], sessions: [], weeklyConstraints, oneOffEvents, settings };
  const result1 = recomputeSchedule(now1, data1);
  const tasksById = new Map([[task.id, task]]);

  printSchedule('Scénario C : Session manquée — état initial (lundi matin)', result1, tasksById, weeklyConstraints, oneOffEvents, settings, REF_DATE, addDaysISO(REF_DATE, 5));

  const firstSession = [...result1.sessions].sort((a, b) => (a.date + a.startTime < b.date + b.startTime ? -1 : 1))[0];
  check('Une première session a bien été placée aujourd\'hui (lundi)', firstSession.date === REF_DATE);

  // --- Étape 2 : le lendemain, on marque cette session "non faite" ---------
  const now2 = new Date(2026, 8, 29, 9, 0);
  const sessionsWithMiss = result1.sessions.map((s) => (s.id === firstSession.id ? { ...s, status: 'non_faite' } : s));
  const data2 = { tasks: [task], sessions: sessionsWithMiss, weeklyConstraints, oneOffEvents, settings };
  const result2 = recomputeSchedule(now2, data2);

  printSchedule('Scénario C : après avoir marqué la session de lundi "non faite" (mardi matin)', result2, tasksById, weeklyConstraints, oneOffEvents, settings, REF_DATE, addDaysISO(REF_DATE, 5));

  console.log('Vérifications :');
  runStandardChecks(result2.sessions.filter((s) => s.status !== 'non_faite'), settings, weeklyConstraints, oneOffEvents);

  const missedStillThere = result2.sessions.find((s) => s.id === firstSession.id);
  check("La session manquée reste dans l'historique, inchangée (même horaire, statut non_faite)",
    !!missedStillThere && missedStillThere.status === 'non_faite' && missedStillThere.date === firstSession.date && missedStillThere.startTime === firstSession.startTime);

  const pastBefore = result1.sessions.filter((s) => s.date < REF_DATE); // vide ici, mais vérifie le principe
  const pastAfter = result2.sessions.filter((s) => s.date < addDaysISO(REF_DATE, 1) && s.id !== firstSession.id && s.date <= REF_DATE);
  const untouchedPast = result1.sessions
    .filter((s) => s.date <= REF_DATE && s.id !== firstSession.id)
    .every((s1) => {
      const s2 = result2.sessions.find((s) => s.id === s1.id);
      return s2 && s2.date === s1.date && s2.startTime === s1.startTime && s2.status === s1.status;
    });
  check('Aucune autre session déjà passée n\'a été modifiée', untouchedPast);

  const remainingMinutes = task.estimatedDurationMinutes - firstSession.durationMinutes;
  const futureSessionsForTask = result2.sessions.filter((s) => s.taskId === task.id && s.status === 'planifiee');
  const futureMinutes = futureSessionsForTask.reduce((sum, s) => sum + s.durationMinutes, 0);
  check('Le temps de la session manquée est réintégré dans le travail restant et replanifié', futureMinutes >= remainingMinutes);
  check('La ou les nouvelles sessions sont placées à partir de mardi (pas dans le passé)', futureSessionsForTask.every((s) => s.date >= addDaysISO(REF_DATE, 1)));
}

// ---------------------------------------------------------------------------
// Scénario D — Surcharge impossible
// ---------------------------------------------------------------------------

function scenarioD() {
  const now = new Date(2026, 8, 28, 7, 0);
  const settings = defaultSettings();
  const weeklyConstraints = baseConstraints();
  const oneOffEvents = [];

  // Échéance dès aujourd'hui : seule la capacité du jour même (180 min) est
  // disponible pour 9h de travail à répartir sur 3 tâches -> franchement
  // impossible, contrairement à une échéance à +2 jours qui laisserait le
  // temps de tout caser exactement (3 jours x 180 min = 540 min = 9h).
  const deadline = REF_DATE;
  const tasks = [
    createTask({ subject: 'maths', type: 'dm', title: 'DM Maths (gros)', deadlineDate: deadline, deadlineTime: '20:00', estimatedDurationMinutes: 180, priority: 2 }),
    createTask({ subject: 'physique', type: 'dm', title: 'DM Physique (gros)', deadlineDate: deadline, deadlineTime: '20:00', estimatedDurationMinutes: 180, priority: 2 }),
    createTask({ subject: 'chimie', type: 'dm', title: 'DM Chimie (gros)', deadlineDate: deadline, deadlineTime: '20:00', estimatedDurationMinutes: 180, priority: 2 }),
  ];

  const data = { tasks, sessions: [], weeklyConstraints, oneOffEvents, settings };
  const result = recomputeSchedule(now, data);
  const tasksById = new Map(tasks.map((t) => [t.id, t]));

  printSchedule('Scénario D : Surcharge impossible', result, tasksById, weeklyConstraints, oneOffEvents, settings, REF_DATE, deadline);

  console.log('Vérifications :');
  runStandardChecks(result.sessions, settings, weeklyConstraints, oneOffEvents);

  check("Le moteur émet des avertissements plutôt que de tout entasser en silence", result.warnings.length > 0);
  check('Chaque avertissement cite une durée manquante et une échéance', result.warnings.every((w) => /min|h/.test(w.message) && w.message.includes(formatDateFR(deadline))));

  const totalNeeded = tasks.reduce((sum, t) => sum + t.estimatedDurationMinutes, 0);
  const totalPlaced = result.sessions.filter((s) => s.status === 'planifiee').reduce((sum, s) => sum + s.durationMinutes, 0);
  check(`Une partie du travail est quand même placée dans la limite des disponibilités (${formatDuration(totalPlaced)} sur ${formatDuration(totalNeeded)} demandées)`, totalPlaced > 0 && totalPlaced < totalNeeded);
}

// ---------------------------------------------------------------------------

scenarioA();
scenarioB();
scenarioC();
scenarioD();

console.log(`\n${totalChecks - failedChecks}/${totalChecks} vérifications passées.`);
if (failedChecks > 0) {
  console.log(`${failedChecks} vérification(s) ont échoué — voir les ✗ ci-dessus.`);
  // `process` n'existe pas dans un navigateur : ce script tourne aussi bien
  // via `node tests/scenarios.mjs` que chargé comme module dans une page.
  if (typeof process !== 'undefined') process.exit(1);
}
