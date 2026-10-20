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

/** Résumé de l'environnement, joint aux erreurs pour comprendre ce qui bloque. */
function diagnostics() {
  const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  const ua = navigator.userAgent || '';
  const ios = /iPhone|iPad|iPod/.test(ua);
  const iosVersion = (ua.match(/OS (\d+)[_.](\d+)/) || []).slice(1, 3).join('.');
  return [
    `permission : ${typeof Notification === 'undefined' ? 'API absente' : Notification.permission}`,
    `appli installée (écran d'accueil) : ${standalone ? 'oui' : 'non'}`,
    `service worker : ${'serviceWorker' in navigator ? (navigator.serviceWorker.controller ? 'actif' : 'présent mais pas encore actif') : 'absent'}`,
    ios ? `iOS ${iosVersion || '?'}` : 'appareil non iOS',
  ].join(' · ');
}

function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms))]);
}

/**
 * Bouton "tester" dans les réglages : fait tout le chemin (demande de
 * permission DANS le geste de l'utilisateur — iOS l'exige —, puis affichage
 * via le service worker) et remonte une erreur précise sinon, avec un résumé
 * de l'environnement.
 */
export async function sendTestNotification() {
  if (!isSupported()) throw new Error(`Ce navigateur ne supporte pas l'API Notification. (${diagnostics()})`);

  // Permission : demandée ICI, pendant le toucher du bouton (iOS refuse sinon).
  if (Notification.permission === 'default') await Notification.requestPermission();
  if (Notification.permission === 'denied') {
    throw new Error(
      "les notifications sont refusées pour cette app. Sur iPhone : Réglages → Notifications → Planificateur → Autoriser les notifications. Si l'app n'y figure pas, supprime-la de l'écran d'accueil, réinstalle-la depuis Safari, puis rouvre-la depuis son icône et réessaie. " +
        `(${diagnostics()})`
    );
  }
  if (Notification.permission !== 'granted') {
    throw new Error(`permission non accordée. (${diagnostics()})`);
  }

  await showNotification('Test du planificateur', 'Si tu vois ceci, les notifications fonctionnent sur cet appareil.', true);
}

async function showNotification(title, body, verbose = false) {
  if (!isSupported()) throw new Error("Ce navigateur ne supporte pas l'API Notification.");
  if (Notification.permission !== 'granted') {
    throw new Error(`Permission non accordée (statut actuel : « ${Notification.permission} »).`);
  }
  const options = { body, icon: './icons/icon-192.png', badge: './icons/icon-192.png' };
  const problems = [];

  // registration.showNotification() est la seule voie qui marche sur iOS et
  // Android/Chrome ; le constructeur Notification direct y est interdit.
  if ('serviceWorker' in navigator) {
    try {
      let reg = await navigator.serviceWorker.getRegistration();
      if (!reg) reg = await navigator.serviceWorker.register('./sw.js');
      reg = await withTimeout(navigator.serviceWorker.ready, 5000, "le service worker n'est pas prêt (rouvre l'app depuis son icône puis réessaie)");
      await reg.showNotification(title, options);
      return;
    } catch (e) {
      problems.push(`service worker : ${e && e.message ? e.message : e}`);
      console.warn('Notification via service worker impossible :', e);
    }
  } else {
    problems.push('service worker absent');
  }

  try {
    new Notification(title, options); // repli (ordinateur) ; sur iOS ce constructeur est interdit
  } catch (e) {
    problems.push(`constructeur : ${e && e.message ? e.message : e}`);
    const detail = problems.join(' | ');
    throw new Error(verbose ? `${detail} (${diagnostics()})` : detail);
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
    const deadlineTime = effectiveDeadlineTime(task, state.weeklyConstraints, state.oneOffEvents, state.settings, state.vacations);
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
