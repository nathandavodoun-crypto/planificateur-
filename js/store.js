// Persistance locale (localStorage) + petit pub/sub pour que les vues se
// re-rendent quand les données changent. C'est la SEULE copie des données de
// l'utilisateur (pas de compte, pas de serveur) — voir exportBackup/importBackup
// pour la sauvegarde manuelle.
//
// Toute mutation passe par une fonction exportée d'ici (jamais par un accès
// direct à getState() depuis une vue) afin que le recalcul du planning
// (scheduler.js) soit systématiquement relancé après chaque changement.

import { emptyStore, defaultSettings, createTask, createWeeklyConstraint, createOneOffEvent, SCHEMA_VERSION } from './models.js';
import { recomputeSchedule } from './scheduler.js';

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
  const result = recomputeSchedule(new Date(), state);
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
  state.tasks = state.tasks.filter((t) => t.id !== id);
  state.sessions = state.sessions.filter((s) => s.taskId !== id);
  commit();
}

// ---- Sessions -----------------------------------------------------------

export function setSessionStatus(id, status) {
  const session = state.sessions.find((s) => s.id === id);
  if (!session) return;
  session.status = status;
  session.completedAt = status === 'terminee' ? Date.now() : null;
  commit();
}

// ---- Contraintes récurrentes (cours, sport, repas, trajets) --------------

export function addWeeklyConstraint(partial) {
  const constraint = createWeeklyConstraint(partial);
  state.weeklyConstraints.push(constraint);
  commit();
  return constraint;
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

export function deleteOneOffEvent(id) {
  state.oneOffEvents = state.oneOffEvents.filter((e) => e.id !== id);
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
