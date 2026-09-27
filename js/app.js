// Point d'entrée : routage minimal par hash (#/jour, #/ajouter, #/reglages)
// et re-rendu de la vue courante à chaque changement dans le store.

import { subscribe } from './store.js';
import { renderDayView } from './views/dayView.js';
import { renderTaskFormView } from './views/taskFormView.js';
import { renderTaskListView } from './views/taskListView.js';
import { renderSettingsView } from './views/settingsView.js';

const routes = {
  '#/jour': renderDayView,
  '#/ajouter': renderTaskFormView,
  '#/devoirs': renderTaskListView,
  '#/reglages': renderSettingsView,
};

const appEl = document.getElementById('app');
const navButtons = document.querySelectorAll('.nav-btn');

function currentRoute() {
  return routes[location.hash] ? location.hash : '#/jour';
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

// Service worker : cache des fichiers statiques pour le hors-ligne, et
// condition pour que l'app soit installable ("Ajouter à l'écran d'accueil").
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => {
      console.warn("Le service worker n'a pas pu être installé (l'app fonctionnera quand même en ligne) :", e);
    });
  });
}
