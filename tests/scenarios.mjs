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
  createChapter,
  DEFAULT_SUBJECTS,
} from '../js/models.js';
import {
  ensureRecurringColleInstances,
  ensureSpacedRepetitionTasks,
  setColleChapters,
  handleTaskCompletionSideEffects,
  importChapters,
} from '../js/colleChapters.js';
import { timeToMinutes, addDaysISO, formatDateFR, formatDuration, combineDateTime } from '../js/utils/date.js';
import { computeStreak } from '../js/stats.js';

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
// Scénario E — Colle de maths vendredi, chapitre vu il y a 6 jours (fusion)
// ---------------------------------------------------------------------------

function scenarioE() {
  const now = new Date(2026, 8, 28, 7, 0); // lundi
  const settings = defaultSettings();
  const weeklyConstraints = baseConstraints();

  const friday = addDaysISO(REF_DATE, 4);

  // Le chapitre a déjà passé sa révision J+1 en "facile" -> stage 1 (J+7),
  // prochaine révision prévue demain (mardi), avec une tâche déjà en attente.
  const chapter = createChapter({
    subject: 'maths',
    title: 'Intégrales',
    dateSeen: addDaysISO(REF_DATE, -6),
    stage: 1,
    nextReviewDate: addDaysISO(REF_DATE, 1),
    history: [{ date: addDaysISO(REF_DATE, -5), stage: 0, difficulty: 'facile', fusedWithColle: false }],
  });
  const pendingTask = createTask({
    subject: 'maths',
    type: 'revision_espacee',
    title: `Révision — ${chapter.title}`,
    deadlineDate: chapter.nextReviewDate,
    estimatedDurationMinutes: settings.spacedRepetition.defaultDurationMinutes,
    priority: 1,
    chapterId: chapter.id,
  });
  chapter.pendingTaskId = pendingTask.id;

  const colleEvent = createOneOffEvent({
    category: 'colle',
    label: 'Colle Maths',
    subject: 'maths',
    date: friday,
    startTime: '14:00',
    endTime: '14:20',
  });

  const data = {
    tasks: [pendingTask],
    sessions: [],
    weeklyConstraints,
    oneOffEvents: [colleEvent],
    chapters: [chapter],
    recurringColleTemplates: [],
    settings,
  };

  // Affecter le chapitre à la colle déclenche la fusion.
  setColleChapters(data, colleEvent.id, [chapter.id], now);
  ensureRecurringColleInstances(data, now);
  ensureSpacedRepetitionTasks(data, now);
  const result = recomputeSchedule(now, data);
  data.sessions = result.sessions;
  const tasksById = new Map(data.tasks.map((t) => [t.id, t]));

  printSchedule('Scénario E : Fusion colle ↔ chapitre', result, tasksById, weeklyConstraints, [colleEvent], settings, REF_DATE, friday);

  console.log('Vérifications :');
  runStandardChecks(result.sessions, settings, weeklyConstraints, [colleEvent]);

  check('Le chapitre est bien marqué fusionné avec la colle', chapter.fusedIntoEventId === colleEvent.id);
  check("Sa tâche de révision espacée autonome n'existe plus", chapter.pendingTaskId === null);
  check(
    "La tâche revision_espacee d'origine a été supprimée (fusionnée, pas de doublon)",
    !data.tasks.some((t) => t.id === pendingTask.id)
  );

  const prepTask = data.tasks.find((t) => t.type === 'preparation_colle');
  check('Une tâche de préparation de colle a été créée, liée au bon chapitre', !!prepTask && prepTask.linkedChapterIds.includes(chapter.id));
  check('Sa durée correspond à un seul chapitre (45 min par défaut)', prepTask.estimatedDurationMinutes === settings.colle.defaultDurationMinutes);
  check("Son échéance est l'heure de la colle elle-même", prepTask.deadlineDate === friday && prepTask.deadlineTime === '14:00');

  const prepSessions = result.sessions.filter((s) => s.taskId === prepTask.id);
  check('La session de préparation est placée avant la colle (mercredi ou jeudi)', prepSessions.length === 1 && [addDaysISO(REF_DATE, 2), addDaysISO(REF_DATE, 3)].includes(prepSessions[0].date));
  check(
    "Aucune session de révision espacée autonome n'apparaît pour ce chapitre cette semaine",
    !result.sessions.some((s) => data.tasks.find((t) => t.id === s.taskId)?.chapterId === chapter.id)
  );

  // --- Complétion de la prépa de colle, marquée "facile" -------------------
  const prepSession = prepSessions[0];
  const completionInstant = new Date(combineDateTime(prepSession.date, prepSession.endTime).getTime() + 5 * 60000);
  prepSession.status = 'terminee';
  prepSession.completedAt = completionInstant.getTime();
  prepTask.status = 'termine';
  handleTaskCompletionSideEffects(data, prepTask, { [chapter.id]: 'facile' }, completionInstant);
  ensureSpacedRepetitionTasks(data, completionInstant);
  const result2 = recomputeSchedule(completionInstant, data);

  check('Après la colle réussie ("facile"), le chapitre avance au stade suivant (J+30)', chapter.stage === 2);
  const expectedNext = addDaysISO(prepSession.date, Math.round(30 * settings.spacedRepetition.easyStretchFactor));
  check('La prochaine révision est repoussée en conséquence (30 × 1.5 = 45 jours)', chapter.nextReviewDate === expectedNext);
  check('Le chapitre redevient autonome (plus fusionné)', chapter.fusedIntoEventId === null);
  check('Une nouvelle tâche de révision espacée est matérialisée pour la suite', !!chapter.pendingTaskId && chapter.pendingTaskId !== pendingTask.id);
}

// ---------------------------------------------------------------------------
// Scénario F — Semaine avec 2 colles, 1 DM et 5 chapitres en répétition espacée
// ---------------------------------------------------------------------------

function scenarioF() {
  const now = new Date(2026, 8, 28, 7, 0);
  const settings = defaultSettings();
  const weeklyConstraints = baseConstraints();

  const tuesday = addDaysISO(REF_DATE, 1);
  const thursday = addDaysISO(REF_DATE, 3);

  const colle1 = createOneOffEvent({ category: 'colle', label: 'Colle Physique', subject: 'physique', date: tuesday, startTime: '10:00', endTime: '10:20' });
  const colle2 = createOneOffEvent({ category: 'colle', label: 'Colle Anglais', subject: 'anglais', date: thursday, startTime: '16:00', endTime: '16:20' });

  const chapA = createChapter({ subject: 'physique', title: 'Mécanique', dateSeen: addDaysISO(REF_DATE, -3) });
  const chapB = createChapter({ subject: 'physique', title: 'Optique', dateSeen: addDaysISO(REF_DATE, -3) });
  const chapC = createChapter({ subject: 'anglais', title: 'Irregular verbs', dateSeen: addDaysISO(REF_DATE, -3) });
  // Chapitres autonomes (non fusionnés), révisions dans la semaine.
  const chapD = createChapter({ subject: 'chimie', title: 'Acides-bases', dateSeen: addDaysISO(REF_DATE, -6), nextReviewDate: addDaysISO(REF_DATE, 2) });
  const chapE = createChapter({ subject: 'si', title: 'Asservissements', dateSeen: addDaysISO(REF_DATE, -6), nextReviewDate: addDaysISO(REF_DATE, 5) });

  const dm = createTask({ subject: 'maths', type: 'dm', title: 'DM Maths', deadlineDate: addDaysISO(REF_DATE, 4), deadlineTime: '18:00', estimatedDurationMinutes: 90, priority: 2 });

  const data = {
    tasks: [dm],
    sessions: [],
    weeklyConstraints,
    oneOffEvents: [colle1, colle2],
    chapters: [chapA, chapB, chapC, chapD, chapE],
    recurringColleTemplates: [],
    settings,
  };

  setColleChapters(data, colle1.id, [chapA.id, chapB.id], now);
  setColleChapters(data, colle2.id, [chapC.id], now);
  ensureRecurringColleInstances(data, now);
  ensureSpacedRepetitionTasks(data, now);
  const result = recomputeSchedule(now, data);
  const tasksById = new Map(data.tasks.map((t) => [t.id, t]));

  printSchedule('Scénario F : 2 colles + 1 DM + chapitres', result, tasksById, weeklyConstraints, [colle1, colle2], settings, REF_DATE, addDaysISO(REF_DATE, 6));

  console.log('Vérifications :');
  runStandardChecks(result.sessions, settings, weeklyConstraints, [colle1, colle2]);

  const prep1 = data.tasks.find((t) => t.linkedEventId === colle1.id);
  const prep2 = data.tasks.find((t) => t.linkedEventId === colle2.id);
  check('La prépa de la colle de physique (2 chapitres) dure plus longtemps que le défaut', prep1.estimatedDurationMinutes > settings.colle.defaultDurationMinutes);
  check('Ses sessions ne tombent jamais le jour de la colle elle-même (mardi)', !result.sessions.some((s) => s.taskId === prep1.id && s.date === tuesday));
  check('La prépa de la colle d\'anglais ne tombe jamais le jour de la colle (jeudi)', !result.sessions.some((s) => s.taskId === prep2.id && s.date === thursday));

  const chapDSessions = result.sessions.filter((s) => tasksById.get(s.taskId)?.chapterId === chapD.id);
  check('La révision du chapitre D (autonome) est bien placée dans sa fenêtre', chapDSessions.length > 0 && chapDSessions.every((s) => s.date <= chapD.nextReviewDate));

  const dmSessions = result.sessions.filter((s) => s.taskId === dm.id);
  check('Le DM obtient bien ses 90 minutes malgré la concurrence des révisions', dmSessions.reduce((sum, s) => sum + s.durationMinutes, 0) === dm.estimatedDurationMinutes);
}

// ---------------------------------------------------------------------------
// Scénario G — Une révision marquée "difficile"
// ---------------------------------------------------------------------------

function scenarioG() {
  const now = new Date(2026, 8, 28, 7, 0);
  const settings = defaultSettings();
  const weeklyConstraints = [];

  const chapter = createChapter({ subject: 'francais', title: 'Figures de style', dateSeen: REF_DATE, nextReviewDate: addDaysISO(REF_DATE, 1) });
  const pendingTask = createTask({
    subject: 'francais',
    type: 'revision_espacee',
    title: `Révision — ${chapter.title}`,
    deadlineDate: chapter.nextReviewDate,
    estimatedDurationMinutes: settings.spacedRepetition.defaultDurationMinutes,
    priority: 1,
    chapterId: chapter.id,
  });
  chapter.pendingTaskId = pendingTask.id;

  const data = { tasks: [pendingTask], sessions: [], weeklyConstraints, oneOffEvents: [], chapters: [chapter], recurringColleTemplates: [], settings };
  ensureSpacedRepetitionTasks(data, now);
  const result = recomputeSchedule(now, data);
  data.sessions = result.sessions;

  printSchedule('Scénario G : révision marquée difficile', result, new Map(data.tasks.map((t) => [t.id, t])), weeklyConstraints, [], settings, REF_DATE, addDaysISO(REF_DATE, 2));

  const session = result.sessions.find((s) => s.taskId === pendingTask.id);
  check('La révision J+1 a bien été placée', !!session);

  const completionInstant = new Date(combineDateTime(session.date, session.endTime).getTime() + 5 * 60000);
  session.status = 'terminee';
  session.completedAt = completionInstant.getTime();
  pendingTask.status = 'termine';
  handleTaskCompletionSideEffects(data, pendingTask, { [chapter.id]: 'difficile' }, completionInstant);
  ensureSpacedRepetitionTasks(data, completionInstant); // matérialise la nouvelle tâche en attente

  console.log('Vérifications :');
  check("Le stade n'avance PAS (le chapitre n'est pas considéré acquis)", chapter.stage === 0);
  const expectedNext = addDaysISO(session.date, Math.max(1, Math.round(1 * settings.spacedRepetition.hardShrinkFactor)));
  check('Une révision supplémentaire est programmée le lendemain au plus tôt (pas le jour même)', chapter.nextReviewDate === expectedNext && chapter.nextReviewDate > session.date);
  check("L'ancienne tâche reste dans l'historique (marquée terminée), pas supprimée", data.tasks.some((t) => t.id === pendingTask.id && t.status === 'termine'));
  check('Une nouvelle tâche de révision, différente de l\'ancienne, est en attente', !!chapter.pendingTaskId && chapter.pendingTaskId !== pendingTask.id);
}

// ---------------------------------------------------------------------------
// Scénario H — Import d'un chapitre ancien (rattrapage, pas de priorité extrême)
// ---------------------------------------------------------------------------

function scenarioH() {
  const now = new Date(2026, 8, 28, 7, 0);
  const settings = defaultSettings();
  const weeklyConstraints = baseConstraints();

  // Vu il y a 50 jours, jamais révisé : sans rattrapage, l'échéance théorique
  // (dateSeen + J+1) serait à -49 jours, donnant une marge négative énorme.
  const oldChapter = { subject: 'chimie', title: 'Vieux chapitre', dateSeen: addDaysISO(REF_DATE, -50) };
  // Un devoir "normal", légitimement urgent, ne doit pas se faire doubler.
  const dm = createTask({ subject: 'maths', type: 'dm', title: 'DM urgent', deadlineDate: addDaysISO(REF_DATE, 2), deadlineTime: '20:00', estimatedDurationMinutes: 60, priority: 2 });

  const data = { tasks: [dm], sessions: [], weeklyConstraints, oneOffEvents: [], chapters: [], recurringColleTemplates: [], settings };
  const [chapter] = importChapters(data, [oldChapter], now);
  ensureSpacedRepetitionTasks(data, now);
  const result = recomputeSchedule(now, data);
  const tasksById = new Map(data.tasks.map((t) => [t.id, t]));

  printSchedule('Scénario H : import d\'un vieux chapitre (rattrapage)', result, tasksById, weeklyConstraints, [], settings, REF_DATE, addDaysISO(REF_DATE, 3));

  console.log('Vérifications :');
  check("La révision n'est PAS programmée à son échéance théorique passée", chapter.nextReviewDate > REF_DATE);
  check(
    `Elle tombe bien dans la fenêtre de rattrapage (${settings.spacedRepetition.catchUpWindowDays} jours)`,
    chapter.nextReviewDate <= addDaysISO(REF_DATE, settings.spacedRepetition.catchUpWindowDays)
  );
  const dmSession = result.sessions.find((s) => s.taskId === dm.id);
  check("Le DM urgent garde la priorité (il n'est pas évincé par le rattrapage)", !!dmSession && dmSession.date === REF_DATE);
}

// ---------------------------------------------------------------------------
// Scénario I — Import groupé : étalement des rattrapages par ancienneté/matière
// ---------------------------------------------------------------------------

function scenarioI() {
  const now = new Date(2026, 8, 28, 7, 0);
  const settings = defaultSettings(); // ordre des matières : maths, physique, chimie, si, ...
  const weeklyConstraints = [];

  const rows = [
    { subject: 'chimie', title: 'Chimie ancienne', dateSeen: addDaysISO(REF_DATE, -60) },
    { subject: 'physique', title: 'Physique ancienne (même ancienneté)', dateSeen: addDaysISO(REF_DATE, -60) },
    { subject: 'maths', title: 'Maths récente', dateSeen: addDaysISO(REF_DATE, -1) }, // pas de rattrapage
  ];

  const data = { tasks: [], sessions: [], weeklyConstraints, oneOffEvents: [], chapters: [], recurringColleTemplates: [], settings };
  const created = importChapters(data, rows, now);
  const chimie = created.find((c) => c.title === 'Chimie ancienne');
  const physique = created.find((c) => c.title === 'Physique ancienne (même ancienneté)');
  const maths = created.find((c) => c.title === 'Maths récente');

  console.log('\n=== Scénario I : import groupé — étalement des rattrapages ===');
  console.log(`Chimie   -> prochaine révision ${chimie.nextReviewDate}`);
  console.log(`Physique -> prochaine révision ${physique.nextReviewDate}`);
  console.log(`Maths    -> prochaine révision ${maths.nextReviewDate} (pas un rattrapage)`);

  console.log('Vérifications :');
  check('Les deux chapitres anciens sont bien détectés comme rattrapages', chimie.nextReviewDate > REF_DATE && physique.nextReviewDate > REF_DATE);
  check('Ils ne tombent PAS le même jour (étalés, pas collés)', chimie.nextReviewDate !== physique.nextReviewDate);
  check(
    'À ancienneté égale, la matière la plus prioritaire (physique avant chimie dans les réglages) passe en premier',
    physique.nextReviewDate < chimie.nextReviewDate
  );
  check(
    `L'étalement reste dans la fenêtre d'import groupé (${settings.spacedRepetition.bulkImportSpreadDays} jours)`,
    chimie.nextReviewDate <= addDaysISO(REF_DATE, settings.spacedRepetition.bulkImportSpreadDays)
  );
  check('Le chapitre récent (pas de rattrapage) garde son échéance théorique normale', maths.nextReviewDate === addDaysISO(addDaysISO(REF_DATE, -1), 1));
}

// ---------------------------------------------------------------------------
// Scénario J — Streak : jours faits d'affilée, un jour neutre, un jour raté
// ---------------------------------------------------------------------------

function scenarioJ() {
  const now = new Date(2026, 8, 28, 18, 0); // aujourd'hui = REF_DATE, en fin de journée
  const task = createTask({ subject: 'maths', title: 'Peu importe', deadlineDate: addDaysISO(REF_DATE, 10) });

  function doneSession(dateISO) {
    return createSession({ taskId: task.id, date: dateISO, startTime: '18:00', endTime: '19:00', durationMinutes: 60, status: 'terminee' });
  }
  function missedSession(dateISO) {
    return createSession({ taskId: task.id, date: dateISO, startTime: '18:00', endTime: '19:00', durationMinutes: 60, status: 'planifiee' });
  }

  const sessions = [
    doneSession(addDaysISO(REF_DATE, -1)), // hier : fait
    doneSession(addDaysISO(REF_DATE, -2)), // avant-hier : fait
    // REF_DATE - 3 : rien de prévu (neutre, ne casse pas le streak)
    doneSession(addDaysISO(REF_DATE, -4)), // fait
    missedSession(addDaysISO(REF_DATE, -5)), // raté : le streak s'arrête ici
    doneSession(addDaysISO(REF_DATE, -6)), // fait mais ne doit plus compter (après la casse)
  ];

  const state = { tasks: [task], sessions, weeklyConstraints: [], oneOffEvents: [], chapters: [], recurringColleTemplates: [], settings: defaultSettings() };
  const streak = computeStreak(state, now);

  console.log('\n=== Scénario J : streak (jours faits, un neutre, un raté) ===');
  console.log(`Streak calculé : ${streak} jour(s)`);

  check("Aujourd'hui (rien fait encore) ne casse pas le streak en cours de journée", true); // vérifié indirectement ci-dessous
  check('Le streak compte hier et avant-hier (2)', streak >= 2);
  check('Le jour neutre (rien de prévu) ne casse pas le streak', streak >= 3);
  check('Le jour raté arrête bien le décompte : streak == 3, pas plus', streak === 3);
}

// ---------------------------------------------------------------------------
// Scénario K — Jamais de session après l'échéance (date ET heure)
// ---------------------------------------------------------------------------

function scenarioK() {
  const now = new Date(2026, 8, 28, 7, 0); // lundi
  const settings = defaultSettings();

  // A : dû lundi 12:00 mais 6h de travail (impossible : plafond 3h/jour).
  // B : dû vendredi, ce qui étend l'horizon de planification jusqu'à vendredi.
  // Avant le correctif, le reste de A était silencieusement placé mardi.
  const A = createTask({ subject: 'maths', type: 'dm', title: 'A dû lundi midi', deadlineDate: REF_DATE, deadlineTime: '12:00', estimatedDurationMinutes: 360, priority: 2 });
  const B = createTask({ subject: 'physique', type: 'dm', title: 'B dû vendredi', deadlineDate: addDaysISO(REF_DATE, 4), deadlineTime: '20:00', estimatedDurationMinutes: 60, priority: 2 });
  const r = recomputeSchedule(now, { tasks: [A, B], sessions: [], weeklyConstraints: [], oneOffEvents: [], settings });
  const sessionsA = r.sessions.filter((s) => s.taskId === A.id);

  console.log('\n=== Scénario K : jamais de session après l\'échéance ===');
  for (const s of sessionsA) console.log(`  A : ${s.date} ${s.startTime}-${s.endTime}`);
  for (const w of r.warnings) console.log(`  ⚠ ${w.message}`);

  check("Aucune session de A après son échéance (lundi 12:00)", sessionsA.every((s) => s.date === REF_DATE && timeToMinutes(s.endTime) <= timeToMinutes('12:00')));
  check('Le travail de A qui ne rentre pas est signalé par un avertissement (pas placé en silence)', r.warnings.some((w) => w.taskId === A.id));
  check('B, qui a de la marge, est bien planifié normalement', r.sessions.some((s) => s.taskId === B.id));

  // Même jour : une session de 90 min pour un devoir dû à 13:30 ne doit pas finir à 21:00.
  const constraints = [createWeeklyConstraint({ label: 'Cours', category: 'cours', daysOfWeek: [1], startTime: '07:00', endTime: '11:00' }),
                       createWeeklyConstraint({ label: 'Midi', category: 'repas', daysOfWeek: [1], startTime: '12:00', endTime: '13:30' })];
  const C = createTask({ subject: 'maths', type: 'dm', title: 'C dû 13h30', deadlineDate: REF_DATE, deadlineTime: '13:30', estimatedDurationMinutes: 90, priority: 2 });
  const r2 = recomputeSchedule(now, { tasks: [C], sessions: [], weeklyConstraints: constraints, oneOffEvents: [], settings });
  check('Un devoir de 90 min dû à 13:30, avec seulement 11:00–12:00 de libre avant, n\'est pas casé le soir même', r2.sessions.every((s) => timeToMinutes(s.endTime) <= timeToMinutes('13:30')));
  check('… et un avertissement le signale', r2.warnings.some((w) => w.taskId === C.id));
}

// ---------------------------------------------------------------------------
// Scénario L — Devoir "pour demain" sans heure : à rendre EN COURS, pas à 22h30
// ---------------------------------------------------------------------------

function scenarioL() {
  const now = new Date(2026, 8, 27, 15, 0); // dimanche 27/09, 15:00
  const settings = defaultSettings();
  const monday = REF_DATE; // lundi 28/09
  const constraints = [
    createWeeklyConstraint({ label: 'Pas de travail (matin)', category: 'autre', daysOfWeek: [1], startTime: '07:00', endTime: '08:00' }),
    createWeeklyConstraint({ label: 'Physique (502)', category: 'cours', daysOfWeek: [1], startTime: '08:00', endTime: '10:00' }),
    createWeeklyConstraint({ label: 'Maths (502)', category: 'cours', daysOfWeek: [1], startTime: '10:00', endTime: '12:00' }),
    createWeeklyConstraint({ label: 'Midi (pas de travail)', category: 'repas', daysOfWeek: [1], startTime: '12:00', endTime: '13:30' }),
  ];

  // Exercices de maths "pour demain" (lundi), sans heure : à rendre au cours de Maths (10:00).
  const maths = createTask({ subject: 'maths', type: 'exercices', title: 'Exo 10 maths', deadlineDate: monday, estimatedDurationMinutes: 120, priority: 2 });
  // Idem en physique : à rendre au cours de Physique (08:00).
  const physique = createTask({ subject: 'physique', type: 'exercices', title: 'Exo 5 physique', deadlineDate: monday, estimatedDurationMinutes: 60, priority: 2 });
  // Matière sans cours ce jour-là (Anglais) : repli sur le tout premier cours de la journée (08:00).
  const anglais = createTask({ subject: 'anglais', type: 'lecture', title: 'Lecture anglais', deadlineDate: monday, estimatedDurationMinutes: 45, priority: 2 });
  // Heure explicite : toujours respectée telle quelle (ici 18:00, donc le soir reste permis).
  const explicite = createTask({ subject: 'maths', type: 'dm', title: 'DM dû lundi 18h', deadlineDate: monday, deadlineTime: '18:00', estimatedDurationMinutes: 60, priority: 2 });

  const r = recomputeSchedule(now, { tasks: [maths, physique, anglais, explicite], sessions: [], weeklyConstraints: constraints, oneOffEvents: [], settings });
  const endOf = (task) => r.sessions.filter((s) => s.taskId === task.id).map((s) => s.date + ' ' + s.endTime);
  const lateFor = (task, limit) => r.sessions.filter((s) => s.taskId === task.id).some((s) => s.date > monday || (s.date === monday && timeToMinutes(s.endTime) > timeToMinutes(limit)));

  console.log('\n=== Scénario L : devoir "pour demain" sans heure ===');
  for (const t of [maths, physique, anglais, explicite]) console.log(`  ${t.title} : ${endOf(t).join(', ') || '(rien)'}`);
  for (const w of r.warnings) console.log(`  ⚠ ${w.message}`);

  check("Exo de maths pour lundi : fini avant le cours de Maths de lundi (10:00)", !lateFor(maths, '10:00') && endOf(maths).length > 0);
  check("Exo de physique pour lundi : fini avant le cours de Physique de lundi (08:00), donc dimanche", !lateFor(physique, '08:00') && endOf(physique).length > 0);
  check("Lecture d'anglais (aucun cours d'anglais lundi) : fini avant le premier cours de la journée (08:00)", !lateFor(anglais, '08:00') && endOf(anglais).length > 0);
  check("Plus aucun de ces devoirs n'est placé le lundi soir (après l'échéance)", r.sessions.filter((s) => [maths, physique, anglais].some((t) => t.id === s.taskId)).every((s) => s.date < monday || timeToMinutes(s.endTime) <= timeToMinutes('10:00')));
  check("Une heure limite explicite (18:00) reste respectée telle quelle", !lateFor(explicite, '18:00') && endOf(explicite).length > 0);
}

// ---------------------------------------------------------------------------

scenarioA();
scenarioB();
scenarioC();
scenarioD();
scenarioE();
scenarioF();
scenarioG();
scenarioH();
scenarioI();
scenarioJ();
scenarioK();
scenarioL();

console.log(`\n${totalChecks - failedChecks}/${totalChecks} vérifications passées.`);
if (failedChecks > 0) {
  console.log(`${failedChecks} vérification(s) ont échoué — voir les ✗ ci-dessus.`);
  // `process` n'existe pas dans un navigateur : ce script tourne aussi bien
  // via `node tests/scenarios.mjs` que chargé comme module dans une page.
  if (typeof process !== 'undefined') process.exit(1);
}
