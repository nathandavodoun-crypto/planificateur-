// Persistance locale (localStorage) + petit pub/sub pour que les vues se
// re-rendent quand les données changent. C'est la SEULE copie des données de
// l'utilisateur (pas de compte, pas de serveur) — voir exportBackup/importBackup
// pour la sauvegarde manuelle.
//
// Toute mutation passe par une fonction exportée d'ici (jamais par un accès
// direct à getState() depuis une vue) afin que le recalcul du planning
// (scheduler.js) soit systématiquement relancé après chaque changement.

import { emptyStore, defaultSettings, createTask, createWeeklyConstraint, createOneOffEvent, createRecurringColleTemplate, SCHEMA_VERSION } from './models.js';
import { recomputeSchedule } from './scheduler.js';
import {
  ensureRecurringColleInstances,
  ensureSpacedRepetitionTasks,
  setColleChapters as setColleChaptersImpl,
  cascadeCleanupOneOffEvent,
  deleteTaskCascade,
  isTaskDone,
  handleTaskCompletionSideEffects,
  importChapters,
} from './colleChapters.js';

const STORAGE_KEY = 'planner:v1';

// Table de migrations, vide pour l'instant : le jour où un champ change de
// forme dans models.js, ajouter ici `migrations[nouvelleVersion] = (data) => {...}`.
const migrations = {};

function loadRaw() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyStore();
    const data = JSON.parse(raw);

    let version = data.schemaVersion || 0;
    while (version < SCHEMA_VERSION) {
      version++;
      if (migrations[version]) migrations[version](data);
    }
    data.schemaVersion = SCHEMA_VERSION;

    // Garde-fous si le blob est partiel (ancienne version, édition manuelle...).
    data.settings = { ...defaultSettings(), ...data.settings };
    data.tasks = data.tasks || [];
    data.sessions = data.sessions || [];
    data.weeklyConstraints = data.weeklyConstraints || [];
    data.oneOffEvents = data.oneOffEvents || [];
    data.chapters = data.chapters || [];
    data.recurringColleTemplates = data.recurringColleTemplates || [];
    return data;
  } catch (e) {
    console.warn('Données locales illisibles, redémarrage avec un planning vide.', e);
    return emptyStore();
  }
}

let state = loadRaw();
let warnings = [];
const listeners = new Set();

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Sauvegarde impossible (stockage local plein ou indisponible).', e);
  }
}

function recompute() {
  const now = new Date();
  // Upserts idempotents : matérialisent ce qui doit exister de façon
  // persistante (prochaine occurrence de colle récurrente, tâche de révision
  // espacée en attente) AVANT le recalcul pur du planning — ces entités
  // portent un état qui n'est pas dérivable de rien, contrairement aux
  // sessions que recomputeSchedule jette et régénère à chaque appel.
  ensureRecurringColleInstances(state, now);
  ensureSpacedRepetitionTasks(state, now);

  const result = recomputeSchedule(now, state);
  state.sessions = result.sessions;
  warnings = result.warnings;
}

function commit() {
  recompute();
  persist();
  for (const fn of listeners) fn();
}

// Recalcul initial au chargement de l'app : rattrape le temps qui s'est
// écoulé depuis la dernière ouverture (sessions passées devenues immuables,
// etc.), sans attendre une première mutation.
recompute();
persist();

export function getState() {
  return state;
}

export function getWarnings() {
  return warnings;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---- Tâches -----------------------------------------------------------

export function addTask(partial) {
  const task = createTask(partial);
  state.tasks.push(task);
  commit();
  return task;
}

export function updateTask(id, changes) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;
  Object.assign(task, changes, { updatedAt: Date.now() });
  commit();
}

export function deleteTask(id) {
  deleteTaskCascade(state, id); // libère aussi un éventuel chapitre fusionné
  commit();
}

// ---- Sessions -----------------------------------------------------------

/**
 * @param {string} id
 * @param {'planifiee'|'terminee'|'non_faite'} status
 * @param {Record<string,'facile'|'difficile'>} [difficultyByChapter] — requis
 *   uniquement si cette session complète une tâche de révision espacée ou de
 *   préparation de colle fusionnée (voir handleTaskCompletionSideEffects).
 */
export function setSessionStatus(id, status, difficultyByChapter) {
  const session = state.sessions.find((s) => s.id === id);
  if (!session) return;
  const task = state.tasks.find((t) => t.id === session.taskId);

  const wasDone = task ? isTaskDone(state, task.id) : false;
  session.status = status;
  session.completedAt = status === 'terminee' ? Date.now() : null;
  const isDoneNow = task ? isTaskDone(state, task.id) : false;

  if (task && !wasDone && isDoneNow) {
    task.status = 'termine';
    handleTaskCompletionSideEffects(state, task, difficultyByChapter, new Date());
  } else if (task && wasDone && !isDoneNow) {
    task.status = 'en_cours'; // ré-ouverte (session repassée non faite après coup)
  }

  commit();
}

// ---- Contraintes récurrentes (cours, sport, repas, trajets) --------------

export function addWeeklyConstraint(partial) {
  const constraint = createWeeklyConstraint(partial);
  state.weeklyConstraints.push(constraint);
  commit();
  return constraint;
}

/** Import groupé (ex. tout un emploi du temps) : un seul recalcul pour tous. */
export function addWeeklyConstraintsBulk(rows) {
  const constraints = rows.map((partial) => createWeeklyConstraint(partial));
  state.weeklyConstraints.push(...constraints);
  commit();
  return constraints;
}

/**
 * Remplace en une fois un lot de contraintes déjà importées (celles que
 * `shouldRemove` désigne) par une nouvelle version — évite d'avoir des
 * anciens ET des nouveaux horaires qui se chevauchent après une correction.
 */
export function replaceWeeklyConstraints(shouldRemove, rows) {
  state.weeklyConstraints = state.weeklyConstraints.filter((c) => !shouldRemove(c));
  const constraints = rows.map((partial) => createWeeklyConstraint(partial));
  state.weeklyConstraints.push(...constraints);
  commit();
  return constraints;
}

export function updateWeeklyConstraint(id, changes) {
  const constraint = state.weeklyConstraints.find((c) => c.id === id);
  if (!constraint) return;
  Object.assign(constraint, changes);
  commit();
}

export function deleteWeeklyConstraint(id) {
  state.weeklyConstraints = state.weeklyConstraints.filter((c) => c.id !== id);
  commit();
}

// ---- Événements ponctuels (colles, DS, imprévus) -------------------------

export function addOneOffEvent(partial) {
  const event = createOneOffEvent(partial);
  state.oneOffEvents.push(event);
  commit();
  return event;
}

/** Import groupé (ex. tout un planning de DS d'un coup) : un seul recalcul pour tous. */
export function addOneOffEventsBulk(rows) {
  const events = rows.map((partial) => createOneOffEvent(partial));
  state.oneOffEvents.push(...events);
  commit();
  return events;
}

export function deleteOneOffEvent(id) {
  const event = state.oneOffEvents.find((e) => e.id === id);
  if (event) cascadeCleanupOneOffEvent(state, event); // libère les chapitres fusionnés, sa tâche liée
  state.oneOffEvents = state.oneOffEvents.filter((e) => e.id !== id);
  commit();
}

/** Affecte des chapitres à une colle (crée/màj sa tâche de préparation, gère la fusion). */
export function setColleChapters(eventId, chapterIds) {
  setColleChaptersImpl(state, eventId, chapterIds, new Date());
  commit();
}

// ---- Colles récurrentes ---------------------------------------------------

export function addRecurringColleTemplate(partial) {
  const template = createRecurringColleTemplate(partial);
  state.recurringColleTemplates.push(template);
  commit();
  return template;
}

export function updateRecurringColleTemplate(id, changes) {
  const template = state.recurringColleTemplates.find((t) => t.id === id);
  if (!template) return;
  Object.assign(template, changes);
  commit();
}

// Jamais de suppression en dur (comme les contraintes récurrentes) : on
// désactive seulement, pour ne pas faire disparaître rétroactivement une
// colle déjà générée si l'emploi du temps change.
export function deactivateRecurringColleTemplate(id) {
  updateRecurringColleTemplate(id, { active: false });
}

// ---- Chapitres (répétition espacée) ---------------------------------------

export function addChapter(partial) {
  const [chapter] = importChapters(
    state,
    [{ subject: partial.subject, title: partial.title, dateSeen: partial.dateSeen, lastReviewDate: partial.lastReviewDate || null }],
    new Date()
  );
  commit();
  return chapter;
}

/**
 * Import groupé : plusieurs chapitres d'un coup (matière, titre, date vue en
 * cours). Les éventuels rattrapages (révisions déjà dépassées) sont étalés
 * sur plusieurs jours plutôt que tous collés ensemble — voir colleChapters.js.
 */
export function addChaptersBulk(rows) {
  const chapters = importChapters(state, rows, new Date());
  commit();
  return chapters;
}

export function updateChapter(id, changes) {
  const chapter = state.chapters.find((c) => c.id === id);
  if (!chapter) return;
  Object.assign(chapter, changes, { updatedAt: Date.now() });
  commit();
}

/** Arrête le suivi en répétition espacée sans effacer l'historique. */
export function archiveChapter(id) {
  const chapter = state.chapters.find((c) => c.id === id);
  if (!chapter) return;
  if (chapter.pendingTaskId) deleteTaskCascade(state, chapter.pendingTaskId);
  chapter.status = 'archive';
  chapter.nextReviewDate = null;
  chapter.pendingTaskId = null;
  chapter.updatedAt = Date.now();
  commit();
}

// ---- Réglages -----------------------------------------------------------

export function updateSettings(changes) {
  Object.assign(state.settings, changes);
  commit();
}

// ---- Sauvegarde manuelle (export/import JSON) ----------------------------
// Seule copie des données existante : pas de compte, pas de cloud. Utile
// avant de changer de téléphone, ou si le navigateur venait à vider son
// stockage local.

export function exportBackup() {
  return JSON.stringify(state, null, 2);
}

export function importBackup(json) {
  const data = JSON.parse(json);
  data.schemaVersion = data.schemaVersion || SCHEMA_VERSION;
  state = data;
  commit();
}

// Re-synchronisation si l'app est ouverte dans plusieurs onglets à la fois :
// un changement fait dans un onglet doit se refléter dans les autres.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) {
      state = loadRaw();
      recompute();
      for (const fn of listeners) fn();
    }
  });
}
