// Écran d'accueil : à CHAQUE ouverture de l'app, une des images de l'utilisateur
// s'affiche en plein écran avant l'app (touche pour entrer, ou entrée
// automatique après quelques secondes). Les images sont ajoutées directement
// depuis l'app (Réglages → Écran d'accueil) et stockées dans IndexedDB, sur
// l'appareil : rien n'est envoyé ni publié. Sans image, un écran d'accueil
// « Éveil » (décor de l'app + une phrase) s'affiche à la place.

import { getState } from './store.js';
import { todayISO, combineDateTime } from './utils/date.js';

const DB_NAME = 'planner-splash';
const STORE = 'images';
const LAST_KEY = 'planner:splash:last';
const MAX_SIDE = 1600; // px : assez net pour un téléphone, léger à stocker

const QUOTES = [
  "Aujourd'hui, tu t'y mets.",
  'Une séance à la fois.',
  'Ce que tu fais aujourd’hui, tu le récoltes plus tard.',
  'La régularité bat l’intensité.',
  'Tu as déjà fait le plus dur : commencer.',
  'Concentre-toi : le reste peut attendre.',
  'Chaque séance cochée te rapproche du sommet.',
];

// ---- Stockage (IndexedDB) -------------------------------------------------

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB indisponible'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** @returns {Promise<{id:number, blob:Blob, addedAt:number}[]>} */
export async function listSplashImages() {
  try {
    const db = await openDb();
    const rows = await tx(db, 'readonly', (s) => s.getAll());
    db.close();
    return rows || [];
  } catch (e) {
    console.warn('Images d’accueil illisibles :', e);
    return [];
  }
}

export async function deleteSplashImage(id) {
  const db = await openDb();
  await tx(db, 'readwrite', (s) => s.delete(id));
  db.close();
}

/** Réduit l'image (côté max 1600 px, JPEG) puis l'enregistre. */
export async function addSplashImageFile(file) {
  const blob = await shrinkImage(file);
  const db = await openDb();
  await tx(db, 'readwrite', (s) => s.add({ blob, name: file.name || 'image', addedAt: Date.now() }));
  db.close();
  try {
    // Demande au navigateur de ne pas purger ces images en cas de manque de place.
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  } catch (e) {
    /* meilleur effort */
  }
}

async function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch (e) {
      /* repli sur <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function shrinkImage(file) {
  const bmp = await loadBitmap(file);
  const w = bmp.width || bmp.naturalWidth;
  const h = bmp.height || bmp.naturalHeight;
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000'; // une PNG transparente ne doit pas virer au vert/noir aléatoire
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  if (bmp.close) bmp.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Conversion impossible'))), 'image/jpeg', 0.86);
  });
}

// ---- Affichage ------------------------------------------------------------

function todaySummary() {
  const state = getState();
  const now = new Date();
  const today = todayISO(now);
  const planned = state.sessions
    .filter((s) => s.date === today && s.status === 'planifiee')
    .sort((a, b) => (a.startTime < b.startTime ? -1 : 1));
  if (planned.length === 0) return 'Rien de prévu pour le moment aujourd’hui.';
  const upcoming = planned.find((s) => combineDateTime(s.date, s.startTime).getTime() > now.getTime());
  const count = `${planned.length} séance${planned.length > 1 ? 's' : ''} à faire aujourd’hui`;
  return upcoming ? `${count} · prochaine à ${upcoming.startTime}` : count;
}

function pickIndex(n) {
  let last = -1;
  try {
    last = Number(localStorage.getItem(LAST_KEY));
  } catch (e) {
    /* ignore */
  }
  let i = Math.floor(Math.random() * n);
  if (n > 1 && i === last) i = (i + 1) % n; // jamais deux fois la même d'affilée
  try {
    localStorage.setItem(LAST_KEY, String(i));
  } catch (e) {
    /* ignore */
  }
  return i;
}

/**
 * Affiche l'écran d'accueil. `rows` = images à tirer au sort (vide → écran
 * « Éveil » avec une phrase). Renvoie une promesse résolue à la fermeture.
 */
export function showSplash(rows, { seconds = 4 } = {}) {
  return new Promise((resolve) => {
    let el = document.getElementById('splash');
    if (!el) {
      el = document.createElement('div');
      el.id = 'splash';
      document.body.appendChild(el);
    }
    window.clearTimeout(window.__splashFallback);
    el.className = 'splash';
    el.innerHTML = '';

    let url = null;
    let timer = null;
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      window.clearTimeout(timer);
      el.classList.add('is-leaving');
      window.setTimeout(() => {
        el.remove();
        if (url) URL.revokeObjectURL(url);
        resolve();
      }, 450);
    }

    const foot = document.createElement('div');
    foot.className = 'splash-foot';
    const quote = document.createElement('div');
    quote.className = 'splash-quote';
    quote.textContent = QUOTES[Math.floor(Math.random() * QUOTES.length)];
    const info = document.createElement('div');
    info.className = 'splash-info';
    info.textContent = todaySummary();
    const hint = document.createElement('div');
    hint.className = 'splash-hint';
    hint.textContent = 'Touche pour entrer';
    foot.append(quote, info, hint);

    const progress = document.createElement('div');
    progress.className = 'splash-progress';
    progress.innerHTML = '<i></i>';
    if (seconds > 0) progress.firstChild.style.animationDuration = `${seconds}s`;
    else progress.hidden = true;

    if (rows.length > 0) {
      const row = rows[pickIndex(rows.length)];
      url = URL.createObjectURL(row.blob);
      const bg = document.createElement('div');
      bg.className = 'splash-bg';
      bg.style.backgroundImage = `url("${url}")`;
      const img = document.createElement('img');
      img.className = 'splash-img';
      img.alt = '';
      img.src = url;
      el.append(bg, img);
    } else {
      el.classList.add('is-awake');
      const mark = document.createElement('div');
      mark.className = 'splash-mark';
      mark.textContent = 'Planificateur';
      el.append(mark);
    }
    el.append(foot, progress);

    el.addEventListener('click', close);
    if (seconds > 0) timer = window.setTimeout(close, seconds * 1000);
  });
}

/** À appeler une fois au lancement de l'app. */
export async function startSplash() {
  const el = document.getElementById('splash');
  const cfg = getState().settings.splash || { enabled: true, seconds: 4 };
  if (cfg.enabled === false) {
    if (el) el.remove();
    return;
  }
  const rows = await listSplashImages();
  await showSplash(rows, { seconds: cfg.seconds });
}

export function previewSplash() {
  const cfg = getState().settings.splash || { seconds: 4 };
  return listSplashImages().then((rows) => showSplash(rows, { seconds: cfg.seconds }));
}
