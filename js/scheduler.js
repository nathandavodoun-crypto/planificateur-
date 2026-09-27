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

function firstFit(freeIntervals, duration) {
  for (const [s, e] of freeIntervals) {
    if (e - s >= duration) return { start: s, end: s + duration };
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

function collectBlocksForDate(dateISO, weeklyConstraints, oneOffEvents, blockingSessions) {
  const weekday = weekdayOfISO(dateISO);
  const blocks = [];

  for (const c of weeklyConstraints) {
    if (!c.active) continue;
    if (!c.daysOfWeek.includes(weekday)) continue;
    if (c.effectiveFrom && dateISO < c.effectiveFrom) continue;
    if (c.effectiveUntil && dateISO > c.effectiveUntil) continue;
    blocks.push([timeToMinutes(c.startTime), timeToMinutes(c.endTime)]);
  }
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
  for (const task of tasks) {
    if (task.status === 'termine') continue; // marquée terminée manuellement : rien à planifier
    if (!task.deadlineDate) continue; // garde-fou : pas d'échéance => pas planifiable

    const done = doneMinutesByTask.get(task.id) || 0;
    const remaining = Math.max(0, task.estimatedDurationMinutes - done);
    if (remaining <= 0) continue;

    const alreadyCount = generatedCountByTask.get(task.id) || 0;
    const deadlineTime = task.deadlineTime || settings.dayEndCutoff;
    const deadlineInstant = combineDateTime(task.deadlineDate, deadlineTime);

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

    const { earliestDay, targetLastDay } = computeTargetWindow(todayIso, task.deadlineDate, settings.safetyMarginDays);
    const minGapDays = task.type === 'revision_ds' ? settings.minGapDaysDsRevision : settings.minGapDaysSameTaskDefault;
    const notBeforeDates = distributeNotBeforeDates(durations.length, earliestDay, targetLastDay, minGapDays);

    const slackMinutes = minutesBetween(now, deadlineInstant) - remaining;

    durations.forEach((durationMinutes, i) => {
      units.push({
        taskId: task.id,
        subject: task.subject,
        taskType: task.type,
        sessionIndex: alreadyCount + i,
        durationMinutes,
        deadlineDateISO: task.deadlineDate,
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
    const dayStartMinutes = isToday
      ? Math.max(nowMinutes(now), timeToMinutes(settings.dayStartTime))
      : timeToMinutes(settings.dayStartTime);
    const dayEndMinutes = timeToMinutes(settings.dayEndCutoff);

    if (dayStartMinutes < dayEndMinutes) {
      const blocks = collectBlocksForDate(cursor, weeklyConstraints, oneOffEvents, [...immutable, ...placed]);
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
          const slot = firstFit(free, unit.durationMinutes);
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
