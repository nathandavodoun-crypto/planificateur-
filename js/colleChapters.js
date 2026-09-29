// Colles récurrentes + répétition espacée par chapitre : tout ce qui doit
// EXISTER de façon persistante (contrairement aux sessions, jetées et
// régénérées à chaque recalcul par scheduler.js). Ces fonctions sont des
// upserts idempotents, appelés depuis store.js juste avant recomputeSchedule
// — elles ne touchent jamais aux sessions elles-mêmes, seulement aux tâches,
// événements et chapitres qui servent ensuite d'entrée au moteur pur.

import { createTask, createOneOffEvent } from './models.js';
import { todayISO, weekdayOfISO, addDaysISO, combineDateTime } from './utils/date.js';

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

/** Crée la prochaine occurrence d'une colle récurrente si aucune à venir n'existe déjà. */
export function ensureRecurringColleInstances(state, now) {
  const todayIso = todayISO(now);
  for (const tmpl of state.recurringColleTemplates) {
    if (!tmpl.active) continue;
    const hasUpcoming = state.oneOffEvents.some((e) => e.templateId === tmpl.id && e.date >= todayIso);
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
    if (task.linkedEventId) {
      const ev = findEvent(state, task.linkedEventId);
      if (ev && ev.linkedTaskId === taskId) ev.linkedTaskId = null;
    }
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
