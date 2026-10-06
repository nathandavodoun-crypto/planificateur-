// Moteur de planification — fonction PURE, sans accès au DOM ni au localStorage :
// recomputeSchedule(now, data) -> { sessions, warnings }
//
// Stratégie : recalcul complet à chaque appel. Les sessions déjà terminées, ou
// dont l'horaire est déjà passé, sont conservées telles quelles (immuables) ;
// tout le reste (futur, non fait) est jeté et regénéré. À l'échelle d'un seul
// élève (largement moins de 100 tâches/sessions actives), c'est très rapide et
// ça évite toute une classe de bugs des mises à jour incrémentales.
//
// Priorité : "Least-Slack-Time" par tâche — slack = temps restant avant
// l'échéance moins travail restant. Plus fiable qu'un simple tri par échéance,
// car il tient compte de la charge réellement restante.

import {
  combineDateTime,
  timeToMinutes,
  minutesToTime,
  todayISO,
  nowMinutes,
  addDaysISO,
  diffDaysISO,
  weekdayOfISO,
  isWeekendISO,
  maxISO,
  minutesBetween,
  round5,
  clamp,
  formatDateFR,
  formatDuration,
} from './utils/date.js';
import { createSession } from './models.js';
import { travelBlockForDate } from './travel.js';

// ---------------------------------------------------------------------------
// Arithmétique d'intervalles (minutes depuis minuit, entiers, demi-ouverts [a,b))
// ---------------------------------------------------------------------------

export function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export function subtractIntervals(base, blocksToRemove) {
  const merged = mergeIntervals(blocksToRemove);
  let result = [...base];
  for (const [bStart, bEnd] of merged) {
    const next = [];
    for (const [s, e] of result) {
      if (bEnd <= s || bStart >= e) {
        next.push([s, e]); // pas de chevauchement
        continue;
      }
      if (bStart > s) next.push([s, Math.min(bStart, e)]);
      if (bEnd < e) next.push([Math.max(bEnd, s), e]);
    }
    result = next.filter(([s, e]) => e - s > 0);
  }
  return result.sort((a, b) => a[0] - b[0]);
}

// `maxEnd` : heure (en minutes) avant laquelle la session doit se terminer —
// utilisé le jour même d'une échéance (une session à 20h ne peut pas servir
// un devoir dû à 12h).
function firstFit(freeIntervals, duration, maxEnd = Infinity) {
  for (const [s, e] of freeIntervals) {
    if (Math.min(e, maxEnd) - s >= duration) return { start: s, end: s + duration };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Découpage d'une tâche en sessions
// ---------------------------------------------------------------------------

function splitIntoN(remainingMinutes, n) {
  const base = Math.floor(remainingMinutes / n);
  const remainder = remainingMinutes - base * n;
  const durations = Array(n).fill(base);
  for (let i = 0; i < remainder; i++) durations[i % n] += 1;
  return durations.map(round5).filter((d) => d > 0);
}

/**
 * Découpage régulier respectant la durée max, et évitant de créer des
 * fragments plus courts que la durée min.
 */
export function splitEvenly(remainingMinutes, maxLen, minLen) {
  if (remainingMinutes <= 0) return [];
  if (!(maxLen > 0)) return [round5(remainingMinutes)]; // réglage invalide : une seule session, jamais de boucle infinie
  if (remainingMinutes <= maxLen) return [round5(remainingMinutes)];
  let n = Math.ceil(remainingMinutes / maxLen);
  while (n > 1 && remainingMinutes / n < minLen) n--;
  return splitIntoN(remainingMinutes, n);
}

/**
 * Révision de DS : impose d'abord un NOMBRE de sessions dans [min,max]
 * (plusieurs passages plus courts valent mieux qu'un seul gros bloc — effet
 * de répétition espacée), puis les dimensionne, en garantissant qu'aucune ne
 * dépasse la durée max.
 */
export function planDsRevisionDurations(remainingMinutes, dsSettings, maxLen, minLen) {
  if (remainingMinutes <= 0) return [];
  if (remainingMinutes < dsSettings.minSessions * minLen) {
    // Trop peu de travail pour justifier plusieurs sessions espacées.
    return splitEvenly(remainingMinutes, maxLen, minLen);
  }
  let n = clamp(
    Math.ceil(remainingMinutes / dsSettings.idealSessionLengthMinutes),
    dsSettings.minSessions,
    dsSettings.maxSessions
  );
  while (remainingMinutes / n > maxLen) n++;
  while (n > dsSettings.minSessions && remainingMinutes / n < minLen) n--;
  return splitIntoN(remainingMinutes, n);
}

// ---------------------------------------------------------------------------
// Répartition dans le temps ("pas avant telle date"), avant placement réel
// ---------------------------------------------------------------------------

/**
 * Fenêtre de placement souhaitée pour une tâche : la marge de sécurité est
 * SOUPLE, elle ne fait que tirer la répartition plus tôt — la seule vraie
 * limite dure reste l'échéance elle-même.
 */
function computeTargetWindow(todayIso, deadlineDateISO, safetyMarginDays) {
  const softLastDay = addDaysISO(deadlineDateISO, -safetyMarginDays);
  const targetLastDay = softLastDay < todayIso ? todayIso : softLastDay;
  return { earliestDay: todayIso, targetLastDay };
}

/**
 * Sélectionne la fenêtre de placement selon le type de tâche. Une
 * préparation de colle auto-générée (linkedEventId non nul) se concentre
 * dans les 1-2 jours avant la colle plutôt que de s'étaler depuis
 * aujourd'hui ; une révision espacée se concentre autour de sa date cible
 * avec une petite marge de souplesse — dans les deux cas, la seule vraie
 * limite dure reste l'échéance elle-même (deadlineDate/deadlineTime).
 */
function computeWindowForTask(task, todayIso, settings) {
  if (task.type === 'preparation_colle' && task.linkedEventId) {
    const { revisionLeadDaysMin, revisionLeadDaysMax } = settings.colle;
    const earliestDay = maxISO([todayIso, addDaysISO(task.deadlineDate, -revisionLeadDaysMax)]);
    const targetLastDay = maxISO([earliestDay, addDaysISO(task.deadlineDate, -revisionLeadDaysMin)]);
    return { earliestDay, targetLastDay };
  }
  if (task.type === 'revision_espacee') {
    const earliestDay = maxISO([todayIso, addDaysISO(task.deadlineDate, -settings.spacedRepetition.windowSlackDays)]);
    const targetLastDay = maxISO([earliestDay, task.deadlineDate]);
    return { earliestDay, targetLastDay };
  }
  return computeTargetWindow(todayIso, task.deadlineDate, settings.safetyMarginDays);
}

/**
 * Attribue à chaque session une date plancher ("notBeforeDate"), répartie
 * entre aujourd'hui et la fin de la fenêtre cible. C'est ce mécanisme qui
 * produit l'étalement dans le temps, sans jamais entrer en conflit avec
 * l'urgence réelle (qui reste décidée par le slack au moment du placement).
 */
export function distributeNotBeforeDates(n, earliestDay, targetLastDay, minGapDays) {
  const span = Math.max(0, diffDaysISO(targetLastDay, earliestDay));
  const dates = [];
  for (let i = 0; i < n; i++) {
    const frac = n === 1 ? 0 : i / (n - 1);
    let d = addDaysISO(earliestDay, Math.round(frac * span));
    if (i > 0 && diffDaysISO(d, dates[i - 1]) < minGapDays) {
      d = addDaysISO(dates[i - 1], minGapDays);
    }
    dates.push(d);
  }
  return dates;
}

// ---------------------------------------------------------------------------
// Créneaux bloqués d'une journée donnée
// ---------------------------------------------------------------------------

function collectBlocksForDate(dateISO, weeklyConstraints, oneOffEvents, blockingSessions, settings) {
  const weekday = weekdayOfISO(dateISO);
  const blocks = [];

  for (const c of weeklyConstraints) {
    if (!c.active) continue;
    if (!c.daysOfWeek.includes(weekday)) continue;
    if (c.effectiveFrom && dateISO < c.effectiveFrom) continue;
    if (c.effectiveUntil && dateISO > c.effectiveUntil) continue;
    blocks.push([timeToMinutes(c.startTime), timeToMinutes(c.endTime)]);
  }
  // Trajet retour après le dernier cours de la journée (rien n'est planifié
  // pendant qu'on rentre).
  const travel = travelBlockForDate(dateISO, weeklyConstraints, settings);
  if (travel) blocks.push([timeToMinutes(travel.start), timeToMinutes(travel.end)]);
  for (const ev of oneOffEvents) {
    if (ev.date === dateISO) blocks.push([timeToMinutes(ev.startTime), timeToMinutes(ev.endTime)]);
  }
  for (const s of blockingSessions) {
    if (s.date === dateISO) blocks.push([timeToMinutes(s.startTime), timeToMinutes(s.endTime)]);
  }
  return blocks;
}

function sumMinutesOnDate(dateISO, sessionsList) {
  return sessionsList.filter((s) => s.date === dateISO).reduce((sum, s) => sum + s.durationMinutes, 0);
}

function lastSubjectOnDate(dateISO, sessionsList, tasksById) {
  const onDate = sessionsList.filter((s) => s.date === dateISO);
  if (onDate.length === 0) return null;
  onDate.sort((a, b) => (a.endTime < b.endTime ? -1 : a.endTime > b.endTime ? 1 : 0));
  const task = tasksById.get(onDate[onDate.length - 1].taskId);
  return task ? task.subject : null;
}

// ---------------------------------------------------------------------------
// Heure limite par défaut d'un devoir quand l'utilisateur n'en a pas donné
// ---------------------------------------------------------------------------

// Types dont l'échéance tombe EN COURS (rendu de devoir, évaluation en classe).
const HOMEWORK_TYPES = new Set(['dm', 'exercices', 'lecture', 'autre', 'revision_ds']);
// Types étalés par la répartition progressive (les révisions de DS, de colle et
// espacées ont déjà leur propre logique de fenêtre).
const SPREADABLE_TYPES = new Set(['dm', 'exercices', 'lecture', 'autre']);

function normalizeText(str) {
  return String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * Heure limite RÉELLE d'une tâche (exportée : le moteur, les notifications et
 * la liste des devoirs doivent tous parler de la même échéance).
 *
 * - Heure saisie par l'utilisateur : toujours respectée telle quelle.
 * - Sinon, un devoir "pour demain" se rend EN COURS, pas à 22h30 : l'échéance
 *   est le début du cours concerné ce jour-là (cours dont le libellé commence
 *   par la matière, ex. "Maths (502)"), à défaut le premier cours de la
 *   journée, à défaut la fin de journée.
 * - Une évaluation (révision de DS) ou une préparation de colle saisie à la
 *   main s'arrête d'abord au début du DS / de la colle déclaré ce jour-là
 *   (même matière, ou DS à matières multiples), avant de se rabattre sur les
 *   cours.
 */
export function effectiveDeadlineTime(task, weeklyConstraints, oneOffEvents, settings) {
  if (task.deadlineTime) return task.deadlineTime;

  // Une préparation de colle liée à une colle a déjà une heure précise ; une saisie manuelle non.
  const usesCourseDeadline = HOMEWORK_TYPES.has(task.type) || (task.type === 'preparation_colle' && !task.linkedEventId);
  if (!usesCourseDeadline) return settings.dayEndCutoff;

  const eventCategory = task.type === 'revision_ds' ? 'ds' : task.type === 'preparation_colle' ? 'colle' : null;
  if (eventCategory) {
    const events = (oneOffEvents || []).filter(
      (e) => e.category === eventCategory && e.date === task.deadlineDate && (!e.subject || e.subject === task.subject)
    );
    if (events.length > 0) return events.map((e) => e.startTime).sort()[0];
  }

  const weekday = weekdayOfISO(task.deadlineDate);
  const courses = weeklyConstraints.filter(
    (c) =>
      c.active &&
      c.category === 'cours' &&
      c.daysOfWeek.includes(weekday) &&
      (!c.effectiveFrom || task.deadlineDate >= c.effectiveFrom) &&
      (!c.effectiveUntil || task.deadlineDate <= c.effectiveUntil)
  );
  if (courses.length === 0) return settings.dayEndCutoff;

  const subjectLabel = normalizeText((settings.subjects || []).find((s) => s.id === task.subject)?.label || task.subject);
  const sameSubject = courses.filter((c) => normalizeText(c.label).startsWith(subjectLabel));
  const pool = sameSubject.length > 0 ? sameSubject : courses;
  return pool.map((c) => c.startTime).sort()[0];
}

// ---------------------------------------------------------------------------
// Recalcul complet
// ---------------------------------------------------------------------------

/**
 * @param {Date} now
 * @param {{tasks: object[], sessions: object[], weeklyConstraints: object[], oneOffEvents: object[], settings: object}} data
 * @returns {{sessions: object[], warnings: {type: string, taskId: string, message: string}[]}}
 */
export function recomputeSchedule(now, data) {
  const { tasks, sessions, weeklyConstraints, oneOffEvents, settings } = data;
  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  const todayIso = todayISO(now);

  // --- 1. Sessions immuables : terminées, ou déjà passées dans le temps -----
  const immutable = sessions.filter(
    (s) => s.status === 'terminee' || combineDateTime(s.date, s.endTime).getTime() <= now.getTime()
  );

  const doneMinutesByTask = new Map();
  const generatedCountByTask = new Map();
  for (const s of immutable) {
    generatedCountByTask.set(s.taskId, (generatedCountByTask.get(s.taskId) || 0) + 1);
    if (s.status === 'terminee') {
      doneMinutesByTask.set(s.taskId, (doneMinutesByTask.get(s.taskId) || 0) + s.durationMinutes);
    }
  }

  // --- 2 & 3. Travail restant par tâche, découpé en sessions ----------------
  const units = [];

  // Devoirs à étaler qui partagent la même échéance : chacun reçoit un rang,
  // pour décaler leurs séances au lieu de tout empiler les mêmes jours.
  const spreadCfg = settings.progressiveSpread;
  const spreadRankByTask = new Map();
  const spreadGroupSize = new Map();
  if (spreadCfg && spreadCfg.enabled) {
    for (const task of tasks) {
      if (task.status === 'termine' || !task.deadlineDate || !SPREADABLE_TYPES.has(task.type)) continue;
      if (task.manualSessions && task.manualSessions.length) continue;
      if (task.estimatedDurationMinutes - (doneMinutesByTask.get(task.id) || 0) <= 0) continue;
      const rank = spreadGroupSize.get(task.deadlineDate) || 0;
      spreadRankByTask.set(task.id, rank);
      spreadGroupSize.set(task.deadlineDate, rank + 1);
    }
  }
  for (const task of tasks) {
    if (task.status === 'termine') continue; // marquée terminée manuellement : rien à planifier
    if (!task.deadlineDate) continue; // garde-fou : pas d'échéance => pas planifiable

    const done = doneMinutesByTask.get(task.id) || 0;
    const remaining = Math.max(0, task.estimatedDurationMinutes - done);
    if (remaining <= 0) continue;

    const alreadyCount = generatedCountByTask.get(task.id) || 0;
    const deadlineTime = effectiveDeadlineTime(task, weeklyConstraints, oneOffEvents, settings);
    const deadlineInstant = combineDateTime(task.deadlineDate, deadlineTime);

    // Réviser pour une colle ou un DS qui a déjà eu lieu n'a plus de sens :
    // on n'en replanifie rien (contrairement à un devoir en retard, qui reste
    // à faire même tardivement).
    if ((task.type === 'preparation_colle' || task.type === 'revision_ds') && deadlineInstant.getTime() <= now.getTime()) continue;

    let durations;
    if (task.manualSessions && task.manualSessions.length) {
      // Le découpage manuel de l'utilisateur l'emporte toujours.
      durations = task.manualSessions.slice(alreadyCount).map((s) => s.durationMinutes);
    } else if (task.type === 'revision_ds') {
      durations = planDsRevisionDurations(
        remaining,
        settings.dsRevision,
        settings.maxSessionLengthMinutes,
        settings.minSessionLengthMinutes
      );
    } else {
      durations = splitEvenly(remaining, settings.maxSessionLengthMinutes, settings.minSessionLengthMinutes);
    }
    if (durations.length === 0) continue;

    const { earliestDay, targetLastDay } = computeWindowForTask(task, todayIso, settings);
    const minGapDays = task.type === 'revision_ds' ? settings.minGapDaysDsRevision : settings.minGapDaysSameTaskDefault;

    // Répartition progressive : à plus de 2 jours de l'échéance, la taille visée
    // d'une séance diminue avec le nombre de jours restants (plus loin = plus
    // de séances courtes), sans jamais dépasser un jour par séance.
    let windowStart = earliestDay;
    let windowEnd = targetLastDay;
    if (spreadRankByTask.has(task.id)) {
      const daysSpan = diffDaysISO(targetLastDay, earliestDay);
      if (daysSpan >= 2) {
        const chunk = Math.max(spreadCfg.minChunkMinutes, settings.maxSessionLengthMinutes - spreadCfg.shrinkPerDayMinutes * daysSpan);
        const maxPieces = Math.max(1, Math.floor(remaining / Math.max(1, settings.minSessionLengthMinutes)));
        const pieces = Math.min(Math.ceil(remaining / chunk), daysSpan + 1, maxPieces);
        if (pieces > durations.length) durations = splitIntoN(remaining, pieces);
        // Plusieurs devoirs pour la même échéance : chacun reçoit une fenêtre
        // décalée (début plus tardif, fin plus précoce selon son rang) pour que
        // leurs séances s'intercalent au lieu de s'empiler aux mêmes jours.
        const group = spreadGroupSize.get(task.deadlineDate) || 1;
        if (group > 1 && daysSpan >= 3) {
          const step = daysSpan / durations.length;
          const rank = spreadRankByTask.get(task.id);
          windowStart = addDaysISO(earliestDay, Math.round((rank * step) / group));
          windowEnd = addDaysISO(targetLastDay, -Math.round(((group - 1 - rank) * step) / group));
          if (windowEnd < windowStart) windowEnd = windowStart;
        }
      }
    }
    const notBeforeDates = distributeNotBeforeDates(durations.length, windowStart, windowEnd, minGapDays);

    const slackMinutes = minutesBetween(now, deadlineInstant) - remaining;

    durations.forEach((durationMinutes, i) => {
      units.push({
        taskId: task.id,
        subject: task.subject,
        taskType: task.type,
        sessionIndex: alreadyCount + i,
        durationMinutes,
        deadlineDateISO: task.deadlineDate,
        deadlineMinutes: timeToMinutes(deadlineTime),
        // Déjà en retard : on garde l'ancien comportement (replanifier au plus
        // tôt) plutôt que de rendre le devoir impossible à jamais.
        overdue: deadlineInstant.getTime() <= now.getTime(),
        notBeforeDate: notBeforeDates[i],
        slackMinutes,
        priority: task.priority,
        placed: false,
      });
    });
  }

  // --- 4 & 5. Balayage jour par jour -----------------------------------------
  const placed = [];
  // Toutes les dates déjà occupées par chaque tâche (pas seulement la plus
  // récente) : une session peut être marquée terminée en avance sur une date
  // future, et l'espacement doit rester correct par rapport aux dates encore
  // à placer AVANT cette date-là, pas seulement après.
  const placedDatesByTask = new Map();
  for (const s of immutable) {
    if (!placedDatesByTask.has(s.taskId)) placedDatesByTask.set(s.taskId, []);
    placedDatesByTask.get(s.taskId).push(s.date);
  }

  const horizonEnd = units.length ? maxISO([todayIso, ...units.map((u) => u.deadlineDateISO)]) : todayIso;

  let cursor = todayIso;
  while (cursor <= horizonEnd && units.some((u) => !u.placed)) {
    const isToday = cursor === todayIso;
    // Aujourd'hui : on démarre à la prochaine tranche de 5 minutes (13:13 → 13:15),
    // pour des horaires lisibles plutôt que des sessions à 13:13.
    const dayStartMinutes = isToday
      ? Math.max(Math.ceil(nowMinutes(now) / 5) * 5, timeToMinutes(settings.dayStartTime))
      : timeToMinutes(settings.dayStartTime);
    const dayEndMinutes = timeToMinutes(settings.dayEndCutoff);

    if (dayStartMinutes < dayEndMinutes) {
      const blocks = collectBlocksForDate(cursor, weeklyConstraints, oneOffEvents, [...immutable, ...placed], settings);
      let free = subtractIntervals([[dayStartMinutes, dayEndMinutes]], blocks);

      const dailyCap = isWeekendISO(cursor) ? settings.dailyCapWeekendMinutes : settings.dailyCapWeekdayMinutes;
      const usedToday = sumMinutesOnDate(cursor, immutable) + sumMinutesOnDate(cursor, placed);
      let capRemaining = dailyCap - usedToday;

      let lastSubjectToday = lastSubjectOnDate(cursor, [...immutable, ...placed], tasksById);

      let keepGoing = capRemaining > 0 && free.length > 0;
      while (keepGoing) {
        const eligible = units.filter((u) => {
          if (u.placed) return false;
          if (u.notBeforeDate > cursor) return false;
          if (!u.overdue && cursor > u.deadlineDateISO) return false; // jamais après l'échéance
          const otherDates = placedDatesByTask.get(u.taskId);
          if (!otherDates || otherDates.length === 0) return true;
          const gapNeeded = u.taskType === 'revision_ds' ? settings.minGapDaysDsRevision : settings.minGapDaysSameTaskDefault;
          if (gapNeeded === 0) return true;
          // Distance à la session la plus proche (avant OU après), pas
          // seulement la dernière placée : une session déjà marquée terminée
          // en avance sur une date future ne doit pas bloquer le placement de
          // travail restant sur des jours antérieurs à cette date.
          return otherDates.every((d) => Math.abs(diffDaysISO(cursor, d)) >= gapNeeded);
        });

        if (eligible.length === 0) break;

        eligible.sort((a, b) => {
          if (a.slackMinutes !== b.slackMinutes) return a.slackMinutes - b.slackMinutes; // 1. le moins de marge d'abord
          if (a.notBeforeDate !== b.notBeforeDate) return a.notBeforeDate < b.notBeforeDate ? -1 : 1; // 2. date plancher la plus tôt
          if (a.priority !== b.priority) return b.priority - a.priority; // 3. priorité utilisateur
          const aAlt = a.subject === lastSubjectToday ? 1 : 0;
          const bAlt = b.subject === lastSubjectToday ? 1 : 0;
          return aAlt - bAlt; // 4. préférer alterner la matière
        });

        let placedOne = false;
        for (const unit of eligible) {
          if (unit.durationMinutes > capRemaining) continue;
          const maxEnd = !unit.overdue && cursor === unit.deadlineDateISO ? unit.deadlineMinutes : Infinity;
          const slot = firstFit(free, unit.durationMinutes, maxEnd);
          if (!slot) continue;

          placed.push(
            createSession({
              taskId: unit.taskId,
              sessionIndex: unit.sessionIndex,
              date: cursor,
              startTime: minutesToTime(slot.start),
              endTime: minutesToTime(slot.start + unit.durationMinutes),
              durationMinutes: unit.durationMinutes,
              status: 'planifiee',
            })
          );
          unit.placed = true;
          capRemaining -= unit.durationMinutes;
          if (!placedDatesByTask.has(unit.taskId)) placedDatesByTask.set(unit.taskId, []);
          placedDatesByTask.get(unit.taskId).push(cursor);
          lastSubjectToday = unit.subject;
          // On réserve aussi la pause obligatoire après la session.
          free = subtractIntervals(free, [[slot.start, slot.start + unit.durationMinutes + settings.breakDurationMinutes]]);
          placedOne = true;
          break;
        }
        keepGoing = placedOne && capRemaining > 0 && free.length > 0;
      }
    }

    cursor = addDaysISO(cursor, 1);
  }

  // --- 6. Avertissements ------------------------------------------------------
  const warnings = [];
  const unplacedByTask = new Map();
  for (const u of units) {
    if (u.placed) continue;
    if (!unplacedByTask.has(u.taskId)) unplacedByTask.set(u.taskId, []);
    unplacedByTask.get(u.taskId).push(u);
  }
  for (const [taskId, group] of unplacedByTask) {
    const task = tasksById.get(taskId);
    const shortfall = group.reduce((sum, u) => sum + u.durationMinutes, 0);
    warnings.push({
      type: 'INFEASIBLE_TASK',
      taskId,
      message: `Impossible de caser ${formatDuration(shortfall)} de « ${task ? task.title : taskId} » avant son échéance du ${formatDateFR(task.deadlineDate)}.`,
    });
  }

  return { sessions: [...immutable, ...placed], warnings };
}
