// Notifications "best-effort" : voir la section Notifications des Réglages
// pour l'explication honnête de ce qui est réellement garanti sans serveur.
// Ce module ne fait que vérifier périodiquement, pendant que l'app est
// ouverte (ou vient d'être rouverte), s'il y a quelque chose à signaler —
// il ne peut rien déclencher pendant que l'app est totalement fermée.

import { getState } from './store.js';
import { effectiveDeadlineTime } from './scheduler.js';
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

/**
 * Bouton "tester" dans les réglages : vérifie tout de suite si une
 * notification s'affiche vraiment, en remontant une erreur précise sinon
 * (contrairement aux vérifications périodiques, qui échouent en silence).
 */
export async function sendTestNotification() {
  await showNotification('Test du planificateur', 'Si tu vois ceci, les notifications fonctionnent sur cet appareil.');
}

async function showNotification(title, body) {
  if (!isSupported()) throw new Error("Ce navigateur ne supporte pas l'API Notification.");
  if (Notification.permission !== 'granted') {
    throw new Error(`Permission non accordée (statut actuel : « ${Notification.permission} »).`);
  }
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
  new Notification(title, options); // si ça échoue ici, l'erreur remonte à l'appelant
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
      showNotification('Session à venir', `${task ? task.title : 'Une session'} commence à ${session.startTime}`).catch((e) =>
        console.warn('Notification "session à venir" impossible :', e)
      );
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
    if (task.dailyMinutes) continue; // révision quotidienne de DS : déjà rappelée par ses séances du jour
    const doneMinutes = state.sessions
      .filter((s) => s.taskId === task.id && s.status === 'terminee')
      .reduce((sum, s) => sum + s.durationMinutes, 0);
    if (doneMinutes >= task.estimatedDurationMinutes) continue;

    // Même échéance que le planificateur (début du cours concerné si aucune heure n'est saisie).
    const deadlineTime = effectiveDeadlineTime(task, state.weeklyConstraints, state.oneOffEvents, state.settings);
    const deadlineInstant = combineDateTime(task.deadlineDate, deadlineTime);
    const hoursUntil = minutesBetween(now, deadlineInstant) / 60;
    const key = `${task.id}:${todayIso}`;
    if (hoursUntil >= 0 && hoursUntil <= cfg.notifyDeadlineWarningHoursBefore && !notifiedTaskDeadlineDays.has(key)) {
      showNotification('Échéance proche', `« ${task.title} » n'est pas terminé, échéance dans moins de ${Math.ceil(hoursUntil)} h.`).catch((e) =>
        console.warn('Notification "échéance proche" impossible :', e)
      );
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
