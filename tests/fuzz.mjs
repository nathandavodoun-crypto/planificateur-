// Test "à données aléatoires" du moteur : génère des milliers de situations
// (cours, colles, DS, chapitres, devoirs de tous types, réglages variés) et
// vérifie des règles qui ne doivent JAMAIS être violées, quelle que soit la
// situation. Exécuter : `node tests/fuzz.mjs` ou ouvrir tests/fuzz.html.

import { recomputeSchedule, effectiveDeadlineTime } from '../js/scheduler.js';
import { defaultSettings, createTask, createWeeklyConstraint, createOneOffEvent, createChapter, DEFAULT_SUBJECTS } from '../js/models.js';
import { ensureRecurringColleInstances, ensureSpacedRepetitionTasks, setColleChapters, importChapters } from '../js/colleChapters.js';
import { travelBlockForDate } from '../js/travel.js';
import { timeToMinutes, minutesToTime, addDaysISO, todayISO, weekdayOfISO, isWeekendISO, combineDateTime, nowMinutes } from '../js/utils/date.js';

const ITERATIONS = 3000;

// --- générateur pseudo-aléatoire reproductible (même graine = même scénario) ---
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeRng(seed) {
  const f = mulberry32(seed);
  return {
    int: (lo, hi) => lo + Math.floor(f() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(f() * arr.length)],
    chance: (p) => f() < p,
  };
}

const SUBJECT_IDS = DEFAULT_SUBJECTS.map((s) => s.id);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function genScenario(seed) {
  const r = makeRng(seed);
  const now = new Date(2026, r.int(8, 11), r.int(1, 28), r.int(5, 22), r.pick([0, 3, 5, 13, 30, 45]));
  const todayIso = iso(now);

  const settings = {
    ...defaultSettings(),
    maxSessionLengthMinutes: r.pick([45, 60, 90, 120]),
    breakDurationMinutes: r.pick([0, 10, 15, 20]),
    dailyCapWeekdayMinutes: r.pick([120, 180, 300, 480]),
    dailyCapWeekendMinutes: r.pick([180, 240, 480]),
    travelAfterClassMinutes: r.pick([0, 30, 40]),
    safetyMarginDays: r.pick([0, 1, 2]),
    dayStartTime: r.pick(['07:00', '08:00']),
    dayEndCutoff: r.pick(['22:30', '21:00']),
  };

  const weeklyConstraints = [];
  for (let i = 0, n = r.int(0, 10); i < n; i++) {
    const start = r.int(7, 17) * 60 + r.pick([0, 30]);
    const dur = r.pick([60, 90, 120, 180]);
    const days = [1, 2, 3, 4, 5, 6, 0].filter(() => r.chance(0.35));
    if (days.length === 0) continue;
    weeklyConstraints.push(
      createWeeklyConstraint({
        label: `${r.pick(['Maths', 'Physique', 'Chimie', 'SII', 'Anglais'])} (50${i})`,
        category: r.pick(['cours', 'cours', 'cours', 'sport', 'repas']),
        daysOfWeek: days,
        startTime: minutesToTime(start),
        endTime: minutesToTime(Math.min(start + dur, 23 * 60)),
      })
    );
  }

  const oneOffEvents = [];
  for (let i = 0, n = r.int(0, 6); i < n; i++) {
    const start = r.int(7, 18) * 60 + r.pick([0, 30]);
    oneOffEvents.push(
      createOneOffEvent({
        label: 'Evt',
        category: r.pick(['ds', 'adhoc', 'colle', 'autre']),
        subject: r.chance(0.5) ? r.pick(SUBJECT_IDS) : null,
        date: addDaysISO(todayIso, r.int(0, 14)),
        startTime: minutesToTime(start),
        endTime: minutesToTime(Math.min(start + r.pick([20, 60, 120, 240]), 23 * 60)),
      })
    );
  }

  const state = { tasks: [], sessions: [], weeklyConstraints, oneOffEvents, chapters: [], recurringColleTemplates: [], settings };

  for (let i = 0, n = r.int(1, 8); i < n; i++) {
    const type = r.pick(['dm', 'exercices', 'lecture', 'autre', 'revision_ds', 'preparation_colle']);
    state.tasks.push(
      createTask({
        subject: r.pick(SUBJECT_IDS),
        type,
        title: `T${i}`,
        deadlineDate: addDaysISO(todayIso, r.int(-1, 14)),
        deadlineTime: r.chance(0.5) ? minutesToTime(r.int(8, 22) * 60 + r.pick([0, 30])) : null,
        estimatedDurationMinutes: r.pick([20, 45, 60, 90, 120, 240, 600]),
        priority: r.int(1, 3),
      })
    );
  }

  // Chapitres + colles (prépa de colle fusionnée, révisions espacées).
  const rows = [];
  for (let i = 0, n = r.int(0, 5); i < n; i++) {
    rows.push({ subject: r.pick(SUBJECT_IDS), title: `Chap${i}`, dateSeen: addDaysISO(todayIso, -r.int(0, 60)) });
  }
  const chapters = rows.length ? importChapters(state, rows, now) : [];
  const colles = oneOffEvents.filter((e) => e.category === 'colle' && e.subject);
  for (const colle of colles) {
    const picks = chapters.filter(() => r.chance(0.4)).map((c) => c.id);
    if (picks.length) setColleChapters(state, colle.id, picks, now);
  }
  ensureRecurringColleInstances(state, now);
  ensureSpacedRepetitionTasks(state, now);

  return { now, state, todayIso };
}

export function checkScenario(seed, tamper) {
  const { now, state, todayIso } = genScenario(seed);
  const { settings, weeklyConstraints, oneOffEvents, tasks } = state;
  const result = recomputeSchedule(now, state);
  if (tamper) tamper(result, state); // utilisé par l'auto-vérification : on sabote le résultat pour voir si le test le détecte
  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  const problems = [];
  const fail = (rule, detail) => problems.push({ rule, detail });

  const dayStart = timeToMinutes(settings.dayStartTime);
  const dayEnd = timeToMinutes(settings.dayEndCutoff);
  const byDate = new Map();

  for (const s of result.sessions) {
    const task = tasksById.get(s.taskId);
    const a = timeToMinutes(s.startTime);
    const b = timeToMinutes(s.endTime);
    const where = `${task?.title}(${task?.type}) ${s.date} ${s.startTime}-${s.endTime}`;
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date).push(s);

    // R1 bornes de journée + pas dans le passé
    if (s.date < todayIso) fail('R1 session dans le passé', where);
    if (s.date === todayIso && a < nowMinutes(now)) fail('R1 session qui commence avant maintenant', where);
    if (a < dayStart || b > dayEnd) fail('R1 hors des bornes de la journée', where);

    // R2 pas de chevauchement avec cours/événements/trajet
    const weekday = weekdayOfISO(s.date);
    for (const c of weeklyConstraints) {
      if (c.active && c.daysOfWeek.includes(weekday) && a < timeToMinutes(c.endTime) && timeToMinutes(c.startTime) < b) {
        fail('R2 chevauche un créneau récurrent', `${where} x ${c.label} ${c.startTime}-${c.endTime}`);
      }
    }
    for (const e of oneOffEvents) {
      if (e.date === s.date && a < timeToMinutes(e.endTime) && timeToMinutes(e.startTime) < b) {
        fail('R2 chevauche un événement ponctuel', `${where} x ${e.category} ${e.startTime}-${e.endTime}`);
      }
    }
    const travel = travelBlockForDate(s.date, weeklyConstraints, settings);
    if (travel && a < timeToMinutes(travel.end) && timeToMinutes(travel.start) < b) fail('R2 chevauche le trajet retour', `${where} x ${travel.start}-${travel.end}`);

    // R4 durée
    if (!(b - a > 0)) fail('R4 durée nulle ou négative', where);
    if (b - a > settings.maxSessionLengthMinutes + 5 && !task?.manualSessions) fail('R4 session plus longue que le maximum', `${where} (max ${settings.maxSessionLengthMinutes})`);

    // R6 jamais après l'échéance (sauf tâche déjà en retard)
    if (task && task.deadlineDate) {
      const dl = effectiveDeadlineTime(task, weeklyConstraints, oneOffEvents, settings);
      const deadlineInstant = combineDateTime(task.deadlineDate, dl);
      if (deadlineInstant.getTime() > now.getTime() && combineDateTime(s.date, s.endTime).getTime() > deadlineInstant.getTime()) {
        fail('R6 session après l’échéance', `${where} échéance ${task.deadlineDate} ${dl}`);
      }
    }
  }

  // R3 pas de chevauchement entre sessions + pause, R5 plafond par jour
  for (const [date, list] of byDate) {
    list.sort((x, y) => (x.startTime < y.startTime ? -1 : 1));
    let total = 0;
    for (let i = 0; i < list.length; i++) {
      total += list[i].durationMinutes;
      if (i > 0) {
        const gap = timeToMinutes(list[i].startTime) - timeToMinutes(list[i - 1].endTime);
        if (gap < 0) fail('R3 deux sessions se chevauchent', `${date} ${list[i - 1].startTime}-${list[i - 1].endTime} / ${list[i].startTime}-${list[i].endTime}`);
        else if (gap < settings.breakDurationMinutes) fail('R3 pause trop courte entre sessions', `${date} gap=${gap} (min ${settings.breakDurationMinutes})`);
      }
    }
    const cap = isWeekendISO(date) ? settings.dailyCapWeekendMinutes : settings.dailyCapWeekdayMinutes;
    if (total > cap + 5 * list.length) fail('R5 plafond journalier dépassé', `${date} ${total} min > ${cap}`);
  }

  // R7 tout le travail est soit placé, soit signalé
  const warned = new Set(result.warnings.map((w) => w.taskId));
  for (const t of tasks) {
    if (t.status === 'termine' || !t.deadlineDate) continue;
    // Révision de DS / préparation de colle dont l'échéance est passée : le moteur les ignore volontairement.
    if (t.type === 'preparation_colle' || t.type === 'revision_ds') {
      const dl = combineDateTime(t.deadlineDate, effectiveDeadlineTime(t, weeklyConstraints, oneOffEvents, settings));
      if (dl.getTime() <= now.getTime()) continue;
    }
    const placed = result.sessions.filter((s) => s.taskId === t.id);
    const sum = placed.reduce((acc, s) => acc + s.durationMinutes, 0);
    const slackRounding = 5 * Math.max(1, placed.length);
    if (sum > t.estimatedDurationMinutes + slackRounding) fail('R7 plus de travail placé que demandé', `${t.title} ${sum} > ${t.estimatedDurationMinutes}`);
    if (sum + slackRounding < t.estimatedDurationMinutes && !warned.has(t.id)) fail('R7 travail manquant sans avertissement', `${t.title}(${t.type}) ${sum}/${t.estimatedDurationMinutes} échéance ${t.deadlineDate}`);
  }

  // R8 déterminisme : mêmes données → même planning
  const again = recomputeSchedule(now, { ...state, sessions: [] });
  const key = (res) => res.sessions.map((s) => `${s.taskId}|${s.date}|${s.startTime}|${s.endTime}`).sort().join(';');
  if (key(again) !== key(result)) fail('R8 résultat différent pour des données identiques', `seed ${seed}`);

  return problems;
}

// Compte ce que les scénarios exercent réellement (un test qui ne couvre rien ne prouve rien).
function coverage(iterations) {
  const c = { sessions: 0, avecAvertissement: 0, avecPrepColleAuto: 0, avecRevisionEspacee: 0, avecDsOuColle: 0, avecTrajet: 0, avecCours: 0, tachesEnRetard: 0 };
  for (let seed = 1; seed <= iterations; seed++) {
    const { now, state } = genScenario(seed);
    const res = recomputeSchedule(now, state);
    c.sessions += res.sessions.length;
    if (res.warnings.length) c.avecAvertissement++;
    if (state.tasks.some((t) => t.type === 'preparation_colle' && t.linkedEventId)) c.avecPrepColleAuto++;
    if (state.tasks.some((t) => t.type === 'revision_espacee')) c.avecRevisionEspacee++;
    if (state.oneOffEvents.some((e) => e.category === 'ds' || e.category === 'colle')) c.avecDsOuColle++;
    if (state.settings.travelAfterClassMinutes > 0 && state.weeklyConstraints.some((w) => w.category === 'cours')) c.avecTrajet++;
    if (state.weeklyConstraints.some((w) => w.category === 'cours')) c.avecCours++;
    c.tachesEnRetard += state.tasks.filter((t) => combineDateTime(t.deadlineDate, t.deadlineTime || '23:59').getTime() <= now.getTime()).length;
  }
  return c;
}

// Auto-vérification : le test doit DÉTECTER un résultat saboté.
function selfTest(iterations) {
  const sabotages = {
    'session placée après son échéance': (res, state) => {
      const s = res.sessions.find((x) => state.tasks.find((t) => t.id === x.taskId)?.deadlineDate);
      if (s) { const t = state.tasks.find((x) => x.id === s.taskId); s.date = addDaysISO(t.deadlineDate, 1); }
    },
    'deux sessions qui se chevauchent': (res) => {
      if (res.sessions[0]) res.sessions.push({ ...res.sessions[0], id: 'dup' });
    },
    'session pendant un cours': (res, state) => {
      const c = state.weeklyConstraints.find((w) => w.category === 'cours');
      if (res.sessions[0] && c) { const d = [1, 2, 3, 4, 5, 6, 0].includes(c.daysOfWeek[0]) ? c.daysOfWeek[0] : 1; let date = res.sessions[0].date; while (weekdayOfISO(date) !== d) date = addDaysISO(date, 1); res.sessions[0].date = date; res.sessions[0].startTime = c.startTime; res.sessions[0].endTime = minutesToTime(timeToMinutes(c.startTime) + 30); }
    },
  };
  const out = {};
  for (const [name, tamper] of Object.entries(sabotages)) {
    let detected = 0, tried = 0;
    for (let seed = 1; seed <= iterations; seed++) {
      const { state } = genScenario(seed);
      if (!state.tasks.length) continue;
      tried++;
      if (checkScenario(seed, tamper).length > 0) detected++;
    }
    out[name] = `${detected}/${tried} détectés`;
  }
  return out;
}

export function runFuzz(iterations = ITERATIONS, log = console.log) {
  const counts = new Map();
  const examples = new Map();
  let scenariosWithProblems = 0;
  for (let seed = 1; seed <= iterations; seed++) {
    let problems;
    try {
      problems = checkScenario(seed);
    } catch (e) {
      problems = [{ rule: 'CRASH', detail: `seed ${seed}: ${e.message}` }];
    }
    if (problems.length) scenariosWithProblems++;
    for (const p of problems) {
      counts.set(p.rule, (counts.get(p.rule) || 0) + 1);
      if (!examples.has(p.rule)) examples.set(p.rule, []);
      if (examples.get(p.rule).length < 3) examples.get(p.rule).push(`seed ${seed} → ${p.detail}`);
    }
  }
  log(`\n=== Test aléatoire : ${iterations} situations ===`);
  if (counts.size === 0) log('✓ Aucune règle violée.');
  for (const [rule, n] of [...counts].sort()) {
    log(`✗ ${rule} : ${n} fois`);
    for (const ex of examples.get(rule)) log(`    ex. ${ex}`);
  }
  log(`${iterations - scenariosWithProblems}/${iterations} situations sans aucun problème.`);
  log('Couverture :', JSON.stringify(coverage(iterations)));
  log('Auto-vérification (sabotages détectés) :', JSON.stringify(selfTest(Math.min(iterations, 400))));
  return counts;
}

// Lancé directement (node tests/fuzz.mjs ou page fuzz.html)
runFuzz();
