// Colles récurrentes + répétition espacée par chapitre : tout ce qui doit
// EXISTER de façon persistante (contrairement aux sessions, jetées et
// régénérées à chaque recalcul par scheduler.js). Ces fonctions sont des
// upserts idempotents, appelés depuis store.js juste avant recomputeSchedule
// — elles ne touchent jamais aux sessions elles-mêmes, seulement aux tâches,
// événements et chapitres qui servent ensuite d'entrée au moteur pur.

import { createTask, createOneOffEvent, createChapter } from './models.js';
import { todayISO, weekdayOfISO, addDaysISO, combineDateTime, round5 } from './utils/date.js';

function findTask(state, id) {
  return state.tasks.find((t) => t.id === id);
}
function findChapter(state, id) {
  return state.chapters.find((c) => c.id === id);
}
function findEvent(state, id) {
  return state.oneOffEvents.find((e) => e.id === id);
}

// Prochaine date (aujourd'hui incluse) tombant sur `dayOfWeek`. Si c'est
// aujourd'hui mais que le créneau (jusqu'à `endTime`) est déjà passé, on
// saute à la semaine suivante plutôt que de générer une occurrence déjà
// révolue au moment même où elle est créée.
function nextDateForDayOfWeek(now, dayOfWeek, endTime) {
  const todayIso = todayISO(now);
  const todayWeekday = weekdayOfISO(todayIso);
  let diff = (dayOfWeek - todayWeekday + 7) % 7;
  if (diff === 0 && combineDateTime(todayIso, endTime).getTime() <= now.getTime()) {
    diff = 7;
  }
  return addDaysISO(todayIso, diff);
}

/**
 * Calcule la révision initiale d'un chapitre à sa création (toujours au
 * stade 0 : aucune révision n'a encore réellement eu lieu dans l'app). Un
 * chapitre importé avec une date de cours ancienne verrait sa première
 * échéance théorique (dateSeen/dernière révision + premier intervalle) déjà
 * dans le passé — la planifier telle quelle lui donnerait une urgence
 * artificiellement extrême (marge négative énorme) qui écraserait les vrais
 * devoirs urgents. On détecte ce cas (`isCatchUp`) pour que l'appelant lui
 * assigne une date de rattrapage proche à la place ; le cycle facile/
 * difficile reprend ensuite normalement depuis cette révision.
 */
export function computeInitialChapterSchedule(dateSeen, lastReviewDate, now, settings) {
  const todayIso = todayISO(now);
  const anchor = lastReviewDate || dateSeen;
  const theoreticalNext = addDaysISO(anchor, settings.spacedRepetition.baseIntervalsDays[0]);
  const isCatchUp = theoreticalNext < todayIso;
  return {
    stage: 0,
    nextReviewDate: isCatchUp ? null : theoreticalNext, // null => assigné par l'appelant (rattrapage)
    isCatchUp,
  };
}

/**
 * Répartit les dates de rattrapage d'un lot de chapitres importés d'un coup :
 * les plus anciens (puis, à ancienneté égale, la matière la plus prioritaire
 * selon l'ordre de settings.subjects) passent en premier, étalés sur
 * bulkImportSpreadDays plutôt que tous collés dans les mêmes 3 jours.
 */
function assignCatchUpDates(catchUpChapters, now, settings) {
  const todayIso = todayISO(now);
  const subjectOrder = new Map((settings.subjects || []).map((s, i) => [s.id, i]));
  const sorted = [...catchUpChapters].sort((a, b) => {
    if (a.dateSeen !== b.dateSeen) return a.dateSeen < b.dateSeen ? -1 : 1; // plus ancien d'abord
    return (subjectOrder.get(a.subject) ?? 999) - (subjectOrder.get(b.subject) ?? 999);
  });

  const n = sorted.length;
  const span = n > 1 ? settings.spacedRepetition.bulkImportSpreadDays : settings.spacedRepetition.catchUpWindowDays;
  sorted.forEach((chapter, i) => {
    const frac = n === 1 ? 1 : i / (n - 1);
    const offset = n === 1 ? settings.spacedRepetition.catchUpWindowDays : Math.round(1 + frac * (span - 1));
    chapter.nextReviewDate = addDaysISO(todayIso, Math.max(1, offset));
  });
}

/** Crée la prochaine occurrence d'une colle récurrente si aucune à venir n'existe déjà. */
export function ensureRecurringColleInstances(state, now) {
  const todayIso = todayISO(now);
  for (const tmpl of state.recurringColleTemplates) {
    if (!tmpl.active) continue;
    // "À venir" = pas encore terminée À CET INSTANT (et pas seulement "aujourd'hui") :
    // dès que la colle du jour est finie, la semaine suivante est générée.
    const hasUpcoming = state.oneOffEvents.some(
      (e) => e.templateId === tmpl.id && combineDateTime(e.date, e.endTime).getTime() > now.getTime()
    );
    if (hasUpcoming) continue;
    const nextDate = nextDateForDayOfWeek(now, tmpl.dayOfWeek, tmpl.endTime);
    state.oneOffEvents.push(
      createOneOffEvent({
        label: tmpl.label || 'Colle',
        category: 'colle',
        date: nextDate,
        startTime: tmpl.startTime,
        endTime: tmpl.endTime,
        subject: tmpl.subject,
        templateId: tmpl.id,
        createdVia: 'recurring_colle_template',
      })
    );
  }
}

function normalizeText(str) {
  return String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Matière d'un DS : celle de l'événement, sinon la première citée dans son libellé ("Physique / Chimie" → physique). */
function guessDsSubject(event, subjects) {
  if (event.subject) return event.subject;
  const label = normalizeText(event.label);
  let best = null;
  for (const subj of subjects) {
    const idx = label.indexOf(normalizeText(subj.label));
    if (idx >= 0 && (best === null || idx < best.idx)) best = { idx, id: subj.id };
  }
  return best ? best.id : 'autre';
}

/**
 * Révision quotidienne avant chaque DS : une tâche auto-générée par DS à venir,
 * rattachée à l'événement (linkedEventId / event.linkedTaskId). Le moteur en
 * tire UNE séance par jour sur la fenêtre qui précède le DS (voir scheduler.js).
 * Un DS double ("Physique / Chimie") reçoit 1,5× la durée quotidienne.
 */
export function ensureDsRevisionTasks(state, now) {
  const cfg = state.settings.dsDailyRevision;
  for (const event of state.oneOffEvents) {
    if (event.category !== 'ds') continue;
    const existing = event.linkedTaskId ? findTask(state, event.linkedTaskId) : null;
    const wanted = cfg && cfg.enabled !== false && !event.skipDailyRevision;
    if (!wanted) {
      if (existing && existing.type === 'revision_ds' && existing.dailyMinutes) deleteTaskCascade(state, existing.id);
      continue;
    }
    if (combineDateTime(event.date, event.endTime).getTime() <= now.getTime()) continue; // DS passé : on garde l'historique tel quel

    const isDouble = String(event.label || '').includes('/');
    const perDay = round5(cfg.minutesPerDay * (isDouble ? 1.5 : 1));
    const days = Math.max(1, Math.round(cfg.daysBefore));
    const fields = {
      subject: guessDsSubject(event, state.settings.subjects),
      title: `Révision — ${event.label || 'DS'}`,
      deadlineDate: addDaysISO(event.date, -1), // la veille au soir au plus tard
      deadlineTime: state.settings.dayEndCutoff,
      estimatedDurationMinutes: perDay * days,
      dailyMinutes: perDay,
    };
    if (existing) {
      const changed = Object.keys(fields).some((k) => existing[k] !== fields[k]);
      if (changed) Object.assign(existing, fields, { updatedAt: now.getTime() });
    } else {
      const task = createTask({ ...fields, type: 'revision_ds', priority: 2, linkedEventId: event.id });
      state.tasks.push(task);
      event.linkedTaskId = task.id;
    }
  }
}

/** Matérialise la tâche de révision espacée en attente pour chaque chapitre actif non fusionné. */
export function ensureSpacedRepetitionTasks(state, now) {
  for (const ch of state.chapters) {
    if (ch.status !== 'active') continue;
    if (ch.fusedIntoEventId) continue; // la colle à venir s'en charge
    if (!ch.nextReviewDate) continue; // maîtrisé, ou pas encore initialisé
    if (ch.pendingTaskId) {
      if (findTask(state, ch.pendingTaskId)) continue; // déjà en attente
      ch.pendingTaskId = null; // référence orpheline (tâche supprimée ailleurs)
    }
    const task = createTask({
      subject: ch.subject,
      type: 'revision_espacee',
      title: `Révision — ${ch.title}`,
      deadlineDate: ch.nextReviewDate,
      deadlineTime: null,
      estimatedDurationMinutes: state.settings.spacedRepetition.defaultDurationMinutes,
      priority: 1, // basse : moins urgent qu'un devoir à échéance proche
      chapterId: ch.id,
    });
    state.tasks.push(task);
    ch.pendingTaskId = task.id;
  }
}

/** Crée ou met à jour la tâche `preparation_colle` liée à une colle, selon ses chapitres actuels. */
export function upsertPreparationColleTask(state, event, now) {
  if (!event.chapterIds || event.chapterIds.length === 0) {
    if (event.linkedTaskId) {
      deleteTaskCascade(state, event.linkedTaskId);
      event.linkedTaskId = null;
    }
    return;
  }
  const cfg = state.settings.colle;
  const duration = cfg.defaultDurationMinutes + cfg.extraMinutesPerExtraChapter * Math.max(0, event.chapterIds.length - 1);

  let task = event.linkedTaskId ? findTask(state, event.linkedTaskId) : null;
  if (!task) {
    task = createTask({
      subject: event.subject,
      type: 'preparation_colle',
      title: `Préparation — ${event.label || 'colle'}`,
      deadlineDate: event.date,
      deadlineTime: event.startTime,
      estimatedDurationMinutes: duration,
      priority: 2,
      linkedEventId: event.id,
      linkedChapterIds: [...event.chapterIds],
    });
    state.tasks.push(task);
    event.linkedTaskId = task.id;
  } else {
    task.estimatedDurationMinutes = duration;
    task.linkedChapterIds = [...event.chapterIds];
    task.deadlineDate = event.date;
    task.deadlineTime = event.startTime;
    task.updatedAt = now.getTime();
  }
}

/**
 * Affecte des chapitres à une colle (décide la fusion une seule fois, à cet
 * instant précis — jamais réévaluée en continu). Un chapitre ajouté perd sa
 * tâche de révision espacée autonome (elle est fusionnée dans la prépa de
 * colle) ; un chapitre retiré redevient autonome au prochain recalcul.
 */
export function setColleChapters(state, eventId, newChapterIds, now) {
  const event = findEvent(state, eventId);
  if (!event) return;
  const oldIds = event.chapterIds || [];
  const added = newChapterIds.filter((id) => !oldIds.includes(id));
  const removed = oldIds.filter((id) => !newChapterIds.includes(id));
  event.chapterIds = newChapterIds;

  for (const chId of removed) {
    const ch = findChapter(state, chId);
    if (ch && ch.fusedIntoEventId === eventId) ch.fusedIntoEventId = null;
  }
  for (const chId of added) {
    const ch = findChapter(state, chId);
    if (!ch) continue;
    if (ch.pendingTaskId) {
      deleteTaskCascade(state, ch.pendingTaskId);
      ch.pendingTaskId = null;
    }
    ch.fusedIntoEventId = eventId;
  }

  upsertPreparationColleTask(state, event, now);
}

/** Supprime une tâche en nettoyant les références croisées qu'elle porte. */
export function deleteTaskCascade(state, taskId) {
  const task = findTask(state, taskId);
  if (!task) return;

  if (task.type === 'revision_espacee' && task.chapterId) {
    const ch = findChapter(state, task.chapterId);
    if (ch && ch.pendingTaskId === taskId) ch.pendingTaskId = null;
  }
  if (task.type === 'preparation_colle' && task.linkedChapterIds?.length) {
    for (const chId of task.linkedChapterIds) {
      const ch = findChapter(state, chId);
      if (ch && ch.fusedIntoEventId === task.linkedEventId) ch.fusedIntoEventId = null;
    }
  }
  if (task.linkedEventId) {
    const ev = findEvent(state, task.linkedEventId);
    if (ev && ev.linkedTaskId === taskId) ev.linkedTaskId = null;
  }

  state.tasks = state.tasks.filter((t) => t.id !== taskId);
  state.sessions = state.sessions.filter((s) => s.taskId !== taskId);
}

/** À appeler avant de retirer un OneOffEvent du store (libère les chapitres fusionnés, supprime sa tâche liée). */
export function cascadeCleanupOneOffEvent(state, event) {
  for (const chId of event.chapterIds || []) {
    const ch = findChapter(state, chId);
    if (ch && ch.fusedIntoEventId === event.id) ch.fusedIntoEventId = null;
  }
  if (event.linkedTaskId) deleteTaskCascade(state, event.linkedTaskId);
}

/** Une tâche est "faite" quand la somme des sessions terminées couvre sa durée estimée. */
export function isTaskDone(state, taskId) {
  const task = findTask(state, taskId);
  if (!task) return true;
  const doneMinutes = state.sessions
    .filter((s) => s.taskId === taskId && s.status === 'terminee')
    .reduce((sum, s) => sum + s.durationMinutes, 0);
  return doneMinutes >= task.estimatedDurationMinutes;
}

/**
 * Enregistre le résultat d'une révision (facile => intervalle suivant
 * allongé ; difficile => révision supplémentaire ajoutée plus tôt, sans
 * avancer d'étape) et efface la tâche en attente pour laisser
 * ensureSpacedRepetitionTasks en matérialiser une nouvelle.
 */
export function applyReviewOutcome(state, chapter, difficulty, now) {
  const cfg = state.settings.spacedRepetition;
  const todayIso = todayISO(now);
  chapter.history.push({ date: todayIso, stage: chapter.stage, difficulty, fusedWithColle: !!chapter.fusedIntoEventId });

  if (difficulty === 'facile') {
    chapter.stage += 1;
    if (chapter.stage >= cfg.baseIntervalsDays.length) {
      chapter.status = 'maitrise';
      chapter.nextReviewDate = null;
      chapter.pendingTaskId = null;
      chapter.updatedAt = now.getTime();
      return;
    }
    chapter.nextReviewDate = addDaysISO(todayIso, Math.round(cfg.baseIntervalsDays[chapter.stage] * cfg.easyStretchFactor));
  } else {
    // max(1, ...) : sans ce plancher, round(1 * 0.4) = 0 reprogrammerait la
    // révision le jour même dès la toute première étape (J+1).
    const gap = Math.max(1, Math.round(cfg.baseIntervalsDays[chapter.stage] * cfg.hardShrinkFactor));
    chapter.nextReviewDate = addDaysISO(todayIso, gap);
  }
  chapter.pendingTaskId = null;
  chapter.updatedAt = now.getTime();
}

/**
 * Déclenchée quand une tâche passe entièrement à l'état "terminée" (voir
 * isTaskDone dans store.js) : applique facile/difficile au(x) chapitre(s)
 * concerné(s). `difficultyByChapter` est une map {chapterId: 'facile'|'difficile'}
 * — pour une révision espacée simple, la clé est `task.chapterId`.
 */
export function handleTaskCompletionSideEffects(state, task, difficultyByChapter, now) {
  if (task.type === 'revision_espacee' && task.chapterId) {
    const ch = findChapter(state, task.chapterId);
    const difficulty = difficultyByChapter?.[task.chapterId];
    if (ch && ch.status === 'active' && difficulty) {
      applyReviewOutcome(state, ch, difficulty, now);
    }
  }
  if (task.type === 'preparation_colle' && task.linkedChapterIds?.length) {
    for (const chId of task.linkedChapterIds) {
      const ch = findChapter(state, chId);
      if (!ch) continue;
      const difficulty = difficultyByChapter?.[chId];
      if (ch.status === 'active' && ch.fusedIntoEventId === task.linkedEventId && difficulty) {
        applyReviewOutcome(state, ch, difficulty, now);
      }
      if (ch.fusedIntoEventId === task.linkedEventId) ch.fusedIntoEventId = null;
    }
  }
}

/**
 * Importe un ou plusieurs chapitres d'un coup (saisie rapide ou import
 * groupé) : calcule le stade/la révision initiale de chacun, en étalant les
 * éventuels rattrapages sur plusieurs jours quand il y en a plus d'un.
 * `rows` : [{ subject, title, dateSeen, lastReviewDate? }]
 */
export function importChapters(state, rows, now) {
  const created = [];
  const catchUpChapters = [];

  for (const row of rows) {
    const { stage, nextReviewDate, isCatchUp } = computeInitialChapterSchedule(
      row.dateSeen,
      row.lastReviewDate || null,
      now,
      state.settings
    );
    const chapter = createChapter({
      subject: row.subject,
      title: row.title,
      dateSeen: row.dateSeen,
      lastReviewDate: row.lastReviewDate || null,
      stage,
      nextReviewDate, // null si rattrapage : assigné juste après
    });
    created.push(chapter);
    if (isCatchUp) catchUpChapters.push(chapter);
  }

  if (catchUpChapters.length > 0) {
    assignCatchUpDates(catchUpChapters, now, state.settings);
  }

  state.chapters.push(...created);
  return created;
}
