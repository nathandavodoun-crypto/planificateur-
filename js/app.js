// Point d'entrée : routage minimal par hash (#/jour, #/semaine, #/ajouter,
// #/devoirs, #/reglages — avec paramètres optionnels du type
// #/ajouter?edit=<id>) et re-rendu de la vue courante à chaque changement
// dans le store.

import { subscribe } from './store.js';
import { renderDayView } from './views/dayView.js';
import { renderWeekView } from './views/weekView.js';
import { renderTaskFormView } from './views/taskFormView.js';
import { renderTaskListView } from './views/taskListView.js';
import { renderSettingsView } from './views/settingsView.js';
import { startNotificationChecks } from './notifications.js';

const routes = {
  '#/jour': renderDayView,
  '#/semaine': renderWeekView,
  '#/ajouter': renderTaskFormView,
  '#/devoirs': renderTaskListView,
  '#/reglages': renderSettingsView,
};

const appEl = document.getElementById('app');
const navButtons = document.querySelectorAll('.nav-btn');

// La partie avant un éventuel "?..." — les paramètres (ex. ?edit=<id>) sont
// lus directement par la vue concernée via location.hash, pas par le routeur.
function routePath() {
  return location.hash.split('?')[0] || '#/jour';
}

function currentRoute() {
  const path = routePath();
  return routes[path] ? path : '#/jour';
}

function render() {
  const route = currentRoute();
  navButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.route === route));
  appEl.innerHTML = '';
  routes[route](appEl);
}

window.addEventListener('hashchange', render);
subscribe(render);

if (!location.hash) location.hash = '#/jour';
render();

startNotificationChecks();

// Service worker : cache des fichiers statiques pour le hors-ligne, et
// condition pour que l'app soit installable ("Ajouter à l'écran d'accueil").
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => {
      console.warn("Le service worker n'a pas pu être installé (l'app fonctionnera quand même en ligne) :", e);
    });
  });
}
