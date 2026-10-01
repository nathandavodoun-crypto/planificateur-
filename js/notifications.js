// Notifications "best-effort" : voir la section Notifications des Réglages
// pour l'explication honnête de ce qui est réellement garanti sans serveur.
// Ce module ne fait que vérifier périodiquement, pendant que l'app est
// ouverte (ou vient d'être rouverte), s'il y a quelque chose à signaler —
// il ne peut rien déclencher pendant que l'app est totalement fermée.

import { getState } from './store.js';
import { todayISO, combineDateTime, minutesBetween } from './utils/date.js';

// Déduplication en mémoire : évite de re-notifier à chaque passage de la
// minuterie pour la même session/échéance. Remise à zéro au rechargement —
// acceptable (au pire une notification se répète une fois après un reload).
const notifiedSessionIds = new Set();
const notifiedTaskDeadlineDays = new Set(); // clé: `${taskId}:${dateISO}`

let intervalId = null;

export function isSupported() {
  return typeof Notification !== 'undefined';
}

export async function requestPermission() {
  if (!isSupported()) return 'unsupported';
  return Notification.requestPermission();
}

async function showNotification(title, body) {
  if (!isSupported() || Notification.permission !== 'granted') return;
  const options = { body, icon: './icons/icon-192.png', badge: './icons/icon-192.png' };
  // registration.showNotification() est nécessaire sur Android/Chrome (le
  // constructeur Notification direct y est souvent indisponible) ; on
  // retombe sur `new Notification()` si aucun service worker n'est prêt.
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, options);
      return;
    } catch (e) {
      console.warn('Notification via service worker impossible, repli direct :', e);
    }
  }
  try {
    new Notification(title, options);
  } catch (e) {
    console.warn('Notification impossible :', e);
  }
}

function checkDueSoon(state, now) {
  const cfg = state.settings.notifications;
  for (const session of state.sessions) {
    if (session.status !== 'planifiee') continue;
    if (notifiedSessionIds.has(session.id)) continue;
    const start = combineDateTime(session.date, session.startTime);
    const minutesUntil = minutesBetween(now, start);
    if (minutesUntil >= 0 && minutesUntil <= cfg.notifyMinutesBeforeSessionStart) {
      const task = state.tasks.find((t) => t.id === session.taskId);
      showNotification('Session à venir', `${task ? task.title : 'Une session'} commence à ${session.startTime}`);
      notifiedSessionIds.add(session.id);
    }
  }
}

function checkDeadlinesApproaching(state, now) {
  const cfg = state.settings.notifications;
  const todayIso = todayISO(now);
  for (const task of state.tasks) {
    if (task.status === 'termine') continue;
    if (!task.deadlineDate) continue;
    const doneMinutes = state.sessions
      .filter((s) => s.taskId === task.id && s.status === 'terminee')
      .reduce((sum, s) => sum + s.durationMinutes, 0);
    if (doneMinutes >= task.estimatedDurationMinutes) continue;

    const deadlineTime = task.deadlineTime || state.settings.dayEndCutoff;
    const deadlineInstant = combineDateTime(task.deadlineDate, deadlineTime);
    const hoursUntil = minutesBetween(now, deadlineInstant) / 60;
    const key = `${task.id}:${todayIso}`;
    if (hoursUntil >= 0 && hoursUntil <= cfg.notifyDeadlineWarningHoursBefore && !notifiedTaskDeadlineDays.has(key)) {
      showNotification('Échéance proche', `« ${task.title} » n'est pas terminé, échéance dans moins de ${Math.ceil(hoursUntil)} h.`);
      notifiedTaskDeadlineDays.add(key);
    }
  }
}

function runChecks() {
  const state = getState();
  if (!state.settings.notifications.enabled) return;
  if (!isSupported() || Notification.permission !== 'granted') return;
  const now = new Date();
  checkDueSoon(state, now);
  checkDeadlinesApproaching(state, now);
}

/** À appeler une fois au chargement de l'app. */
export function startNotificationChecks() {
  if (intervalId) return;
  runChecks();
  intervalId = setInterval(runChecks, 60000);
  // Rattrape ce qui a pu être manqué pendant que l'app était en arrière-plan.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') runChecks();
  });
}
