// Formes de données de l'application (documentées en JSDoc, pas de classes :
// tout est du JSON simple, sérialisable tel quel dans localStorage).
//
// Convention de dates : voir js/utils/date.js (dates = "YYYY-MM-DD", heures = "HH:MM").

/** @typedef {'dm'|'exercices'|'preparation_colle'|'revision_ds'|'revision_chapitre'|'revision_espacee'|'lecture'|'autre'} TaskType */
/** @typedef {'a_faire'|'en_cours'|'termine'} TaskStatus */
/** @typedef {'planifiee'|'terminee'|'non_faite'} SessionStatus */

// Durée par défaut suggérée à la saisie rapide, selon le type de tâche.
// L'utilisateur peut toujours la modifier — c'est juste un point de départ.
export const DEFAULT_DURATION_MINUTES_BY_TYPE = {
  dm: 120,
  exercices: 60,
  preparation_colle: 90,
  revision_ds: 180,
  revision_chapitre: 180,
  revision_espacee: 20,
  lecture: 45,
  autre: 60,
};

export const TASK_TYPE_LABELS = {
  dm: 'DM',
  exercices: 'Exercices',
  preparation_colle: 'Préparation de colle',
  revision_ds: 'Révision de DS',
  revision_chapitre: 'Révision de chapitre',
  revision_espacee: 'Révision espacée',
  lecture: 'Lecture',
  autre: 'Autre',
};

export const DEFAULT_SUBJECTS = [
  { id: 'maths', label: 'Maths', color: '#5AA9FF' },
  { id: 'physique', label: 'Physique', color: '#35D6EE' },
  { id: 'chimie', label: 'Chimie', color: '#FF86AE' },
  { id: 'si', label: 'SI', color: '#9C8CFF' },
  { id: 'francais', label: 'Français', color: '#FFA98A' },
  { id: 'anglais', label: 'Anglais', color: '#7C9CFF' },
  { id: 'info', label: 'Info', color: '#C9ABFF' },
  { id: 'autre', label: 'Autre', color: '#8693B0' },
];

// Anciennes couleurs par défaut (avant la direction artistique « Éveil ») :
// migrées automatiquement tant que l'utilisateur ne les a pas personnalisées.
export const LEGACY_SUBJECT_COLORS = {
  maths: '#3B82F6', physique: '#10B981', chimie: '#F59E0B', si: '#8B5CF6',
  francais: '#EC4899', anglais: '#EF4444', info: '#06B6D4', autre: '#6B7280',
};

export const SCHEMA_VERSION = 2;

export function defaultSettings() {
  return {
    schemaVersion: SCHEMA_VERSION,

    // Bornes de la journée. Seul le couvre-feu (22h30) était précisé par
    // l'utilisateur ; l'heure de début est une valeur par défaut raisonnable,
    // modifiable dans les réglages.
    dayStartTime: '07:00',
    dayEndCutoff: '22:30',

    // Temps pour rentrer après le dernier cours de la journée : rien n'est
    // planifié pendant ce créneau (l'utilisateur rentre ~30-40 min après).
    travelAfterClassMinutes: 40,

    maxSessionLengthMinutes: 90, // "1h30"
    minSessionLengthMinutes: 25, // évite de créer des miettes de quelques minutes
    breakDurationMinutes: 15, // pause obligatoire entre deux sessions consécutives

    dailyCapWeekdayMinutes: 180,
    dailyCapWeekendMinutes: 240,

    // Marge de sécurité SOUPLE avant une échéance (ne bloque jamais un
    // placement, elle influence juste la répartition — voir scheduler.js).
    safetyMarginDays: 1,

    // Répartition progressive : plus l'échéance d'un devoir est lointaine, plus
    // il est découpé en petites séances étalées (et décalées par rapport aux
    // autres devoirs pour le même jour). Proche de l'échéance : séances longues
    // et regroupées, comme avant.
    progressiveSpread: {
      enabled: true,
      minChunkMinutes: 30, // séance la plus courte visée, même très loin de l'échéance
      shrinkPerDayMinutes: 10, // taille visée = durée max - 10 min par jour restant (plancher ci-dessus)
    },

    // Révision quotidienne avant chaque DS : une séance par jour, chaque jour
    // de la fenêtre qui précède le DS (le DS d'un samedi : du dimanche au vendredi).
    dsDailyRevision: {
      enabled: true,
      minutesPerDay: 60,
      daysBefore: 6,
    },

    // Écran d'accueil au lancement (images ajoutées par l'utilisateur dans l'app).
    splash: {
      enabled: true,
      seconds: 4, // 0 = reste affiché jusqu'au toucher
    },

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

    // Préparation de colle : fenêtre de révision resserrée juste avant la
    // colle (pas étalée depuis aujourd'hui comme un devoir normal).
    colle: {
      revisionLeadDaysMin: 1, // "la veille"
      revisionLeadDaysMax: 2, // "l'avant-veille"
      defaultDurationMinutes: 45,
      extraMinutesPerExtraChapter: 20,
    },

    // Répétition espacée par chapitre : intervalles J+1/J+7/J+30 par défaut,
    // allongés si "facile", raccourcis (révision supplémentaire) si "difficile".
    spacedRepetition: {
      baseIntervalsDays: [1, 7, 30],
      defaultDurationMinutes: 20,
      easyStretchFactor: 1.5,
      hardShrinkFactor: 0.4,
      windowSlackDays: 2,
      // Chapitre importé avec des révisions déjà dépassées : une seule
      // révision de rattrapage, dans les prochains jours plutôt que de
      // replanifier chaque échéance manquée.
      catchUpWindowDays: 3,
      // Lors d'un import groupé, les rattrapages sont étalés sur cette
      // fenêtre (plutôt que tous collés dans catchUpWindowDays) pour ne pas
      // surcharger les premiers jours.
      bulkImportSpreadDays: 10,
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
    dailyMinutes: null, // pour 'revision_ds' auto-généré : minutes à réviser CHAQUE jour avant le DS
    chapterId: null, // pour 'revision_espacee' : le chapitre concerné
    linkedChapterIds: [], // pour 'preparation_colle' auto-généré : chapitres fusionnés
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
    category: 'adhoc', // 'colle' | 'ds' | 'autre' | 'adhoc' | 'repos' (jour de repos : journée entière bloquée)
    date: null,
    startTime: '08:00',
    endTime: '09:00',
    subject: null,
    linkedTaskId: null,
    chapterIds: [], // pour category 'colle' : chapitres couverts
    templateId: null, // pour une colle récurrente : la RecurringColleTemplate d'origine
    createdVia: 'planned', // 'planned' | 'adhoc' | 'recurring_colle_template'
    ...partial,
  };
}

/**
 * Période de vacances : pendant ces dates les cours (et le trajet retour) ne
 * bloquent plus rien, la journée de travail est plus légère (plafond et heure
 * de début propres) et, si `workAhead`, les devoirs dus dans les `aheadDays`
 * jours qui suivent la reprise sont avancés pour être finis avant la fin.
 */
export function createVacation(partial) {
  return {
    id: makeId(),
    label: 'Vacances',
    startDate: null,
    endDate: null,
    dailyCapMinutes: 150, // rythme léger
    startTime: '09:00', // matin libre
    workAhead: true,
    aheadDays: 7,
    // Pas de répétition espacée pendant les vacances : les révisions de
    // chapitres en attente reprennent juste après la fin de la période.
    pauseSpaced: true,
    ...partial,
  };
}

/**
 * Un chapitre vu en cours, suivi en répétition espacée (J+1/J+7/J+30 par
 * défaut). `stage` indexe settings.spacedRepetition.baseIntervalsDays.
 */
export function createChapter(partial) {
  const now = Date.now();
  return {
    id: makeId(),
    subject: 'maths',
    title: '',
    dateSeen: null,
    lastReviewDate: null, // optionnel : déjà révisé soi-même avant d'être ajouté à l'app
    status: 'active', // 'active' | 'maitrise' | 'archive'
    stage: 0,
    nextReviewDate: null,
    pendingTaskId: null, // tâche revision_espacee en attente, ou null si fusionnée/aucune
    fusedIntoEventId: null, // colle qui absorbe la révision en cours, ou null
    history: [], // [{ date, stage, difficulty, fusedWithColle }]
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

/**
 * Un créneau de colle récurrent (même jour/heure chaque semaine) : le
 * contenu (chapitres) change chaque semaine sur l'occurrence générée
 * automatiquement (OneOffEvent avec templateId = cet id).
 */
export function createRecurringColleTemplate(partial) {
  return {
    id: makeId(),
    subject: 'maths',
    label: '',
    dayOfWeek: 1, // 0=dimanche ... 6=samedi
    startTime: '14:00',
    endTime: '14:20',
    active: true,
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
    chapters: [],
    recurringColleTemplates: [],
    vacations: [],
  };
}
