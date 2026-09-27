// Formes de données de l'application (documentées en JSDoc, pas de classes :
// tout est du JSON simple, sérialisable tel quel dans localStorage).
//
// Convention de dates : voir js/utils/date.js (dates = "YYYY-MM-DD", heures = "HH:MM").

/** @typedef {'dm'|'exercices'|'preparation_colle'|'revision_ds'|'lecture'|'autre'} TaskType */
/** @typedef {'a_faire'|'en_cours'|'termine'} TaskStatus */
/** @typedef {'planifiee'|'terminee'|'non_faite'} SessionStatus */

// Durée par défaut suggérée à la saisie rapide, selon le type de tâche.
// L'utilisateur peut toujours la modifier — c'est juste un point de départ.
export const DEFAULT_DURATION_MINUTES_BY_TYPE = {
  dm: 120,
  exercices: 60,
  preparation_colle: 90,
  revision_ds: 180,
  lecture: 45,
  autre: 60,
};

export const TASK_TYPE_LABELS = {
  dm: 'DM',
  exercices: 'Exercices',
  preparation_colle: 'Préparation de colle',
  revision_ds: 'Révision de DS',
  lecture: 'Lecture',
  autre: 'Autre',
};

export const DEFAULT_SUBJECTS = [
  { id: 'maths', label: 'Maths', color: '#3B82F6' },
  { id: 'physique', label: 'Physique', color: '#10B981' },
  { id: 'chimie', label: 'Chimie', color: '#F59E0B' },
  { id: 'si', label: 'SI', color: '#8B5CF6' },
  { id: 'francais', label: 'Français', color: '#EC4899' },
  { id: 'anglais', label: 'Anglais', color: '#EF4444' },
  { id: 'info', label: 'Info', color: '#06B6D4' },
  { id: 'autre', label: 'Autre', color: '#6B7280' },
];

export const SCHEMA_VERSION = 1;

export function defaultSettings() {
  return {
    schemaVersion: SCHEMA_VERSION,

    // Bornes de la journée. Seul le couvre-feu (22h30) était précisé par
    // l'utilisateur ; l'heure de début est une valeur par défaut raisonnable,
    // modifiable dans les réglages.
    dayStartTime: '07:00',
    dayEndCutoff: '22:30',

    maxSessionLengthMinutes: 90, // "1h30"
    minSessionLengthMinutes: 25, // évite de créer des miettes de quelques minutes
    breakDurationMinutes: 15, // pause obligatoire entre deux sessions consécutives

    dailyCapWeekdayMinutes: 180,
    dailyCapWeekendMinutes: 240,

    // Marge de sécurité SOUPLE avant une échéance (ne bloque jamais un
    // placement, elle influence juste la répartition — voir scheduler.js).
    safetyMarginDays: 1,

    minGapDaysSameTaskDefault: 0,
    minGapDaysDsRevision: 1,

    dsRevision: {
      idealSessionLengthMinutes: 45,
      minSessions: 2,
      maxSessions: 5,
    },

    subjects: DEFAULT_SUBJECTS,

    notifications: {
      enabled: false,
      notifyMinutesBeforeSessionStart: 10,
      notifyDeadlineWarningHoursBefore: 24,
    },
  };
}

export function makeId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Repli simple si crypto.randomUUID est indisponible (vieux navigateur).
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * @param {Partial<import('./models.js').Task>} partial
 */
export function createTask(partial) {
  const now = Date.now();
  return {
    id: makeId(),
    subject: 'maths',
    customSubjectLabel: null,
    type: 'dm',
    title: '',
    deadlineDate: null,
    deadlineTime: null,
    estimatedDurationMinutes: 60,
    priority: 2, // 1=basse, 2=normale, 3=haute
    difficulty: null, // optionnel, informatif uniquement (non utilisé par le moteur v1)
    manualSessions: null, // null => découpage automatique
    linkedEventId: null,
    status: 'a_faire',
    notes: '',
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

export function createSession(partial) {
  return {
    id: makeId(),
    taskId: null,
    sessionIndex: 0,
    date: null,
    startTime: null,
    endTime: null,
    durationMinutes: 0,
    status: 'planifiee',
    completedAt: null,
    generatedAt: Date.now(),
    ...partial,
  };
}

export function createWeeklyConstraint(partial) {
  return {
    id: makeId(),
    label: '',
    category: 'cours', // 'cours' | 'sport' | 'repas' | 'trajet' | 'autre'
    daysOfWeek: [], // 0=dimanche ... 6=samedi
    startTime: '08:00',
    endTime: '09:00',
    effectiveFrom: null,
    effectiveUntil: null,
    active: true,
    ...partial,
  };
}

export function createOneOffEvent(partial) {
  return {
    id: makeId(),
    label: '',
    category: 'adhoc', // 'colle' | 'ds' | 'autre' | 'adhoc'
    date: null,
    startTime: '08:00',
    endTime: '09:00',
    subject: null,
    linkedTaskId: null,
    createdVia: 'planned', // 'planned' | 'adhoc'
    ...partial,
  };
}

export function emptyStore() {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: defaultSettings(),
    tasks: [],
    sessions: [],
    weeklyConstraints: [],
    oneOffEvents: [],
  };
}
