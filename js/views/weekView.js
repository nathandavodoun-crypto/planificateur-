// Vue Semaine — grille façon calendrier : heures sur le côté, blocs colorés
// positionnés et dimensionnés selon l'horaire. Pas de glisser-déposer :
// taper un bloc ouvre une fiche avec Modifier/Supprimer (confirmé avec
// l'utilisateur) — c'est toujours l'algorithme qui décide où les sessions
// sont casées.

import { getState, deleteTask, deleteWeeklyConstraint, deleteOneOffEvent } from '../store.js';
import { travelBlockForDate } from '../travel.js';
import { todayISO, addDaysISO, weekdayOfISO, timeToMinutes, minutesToTime, formatDateFR } from '../utils/date.js';

const PX_PER_MINUTE = 0.75;

const CATEGORY_LABELS = {
  cours: 'Cours', sport: 'Sport', repas: 'Repas', trajet: 'Trajet', autre: 'Autre',
  ds: 'DS', colle: 'Colle', adhoc: 'Imprévu',
};

function mondayOf(dateISO) {
  const offset = (weekdayOfISO(dateISO) + 6) % 7; // 0 pour lundi ... 6 pour dimanche
  return addDaysISO(dateISO, -offset);
}

// Semaine actuellement affichée (son lundi) — conservé au niveau du module,
// comme selectedDate dans dayView.
let selectedWeekStart = mondayOf(todayISO(new Date()));

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function subjectMeta(subjectId, settings) {
  return (settings.subjects || []).find((s) => s.id === subjectId) || { label: subjectId, color: '#6B7280' };
}

function collectDayItems(dateISO, state) {
  const weekday = weekdayOfISO(dateISO);
  const items = [];

  for (const c of state.weeklyConstraints) {
    if (!c.active || !c.daysOfWeek.includes(weekday)) continue;
    if (c.effectiveFrom && dateISO < c.effectiveFrom) continue;
    if (c.effectiveUntil && dateISO > c.effectiveUntil) continue;
    items.push({ kind: 'constraint', ref: c, start: c.startTime, end: c.endTime, label: `${CATEGORY_LABELS[c.category]} — ${c.label}`, color: '#6B7280' });
  }
  const travel = travelBlockForDate(dateISO, state.weeklyConstraints, state.settings);
  if (travel) items.push({ kind: 'travel', start: travel.start, end: travel.end, label: 'Trajet retour', color: '#6B7280' });
  for (const ev of state.oneOffEvents) {
    if (ev.date !== dateISO) continue;
    items.push({ kind: 'event', ref: ev, start: ev.startTime, end: ev.endTime, label: `${CATEGORY_LABELS[ev.category]} — ${ev.label}`, color: '#6B7280' });
  }
  for (const s of state.sessions) {
    if (s.date !== dateISO) continue;
    const task = state.tasks.find((t) => t.id === s.taskId);
    const subj = task ? subjectMeta(task.subject, state.settings) : { label: '?', color: '#6B7280' };
    items.push({ kind: 'session', ref: s, task, start: s.startTime, end: s.endTime, label: task ? task.title : '?', color: subj.color });
  }
  return items;
}

export function renderWeekView(container) {
  const state = getState();
  const wrapper = document.createElement('div');
  wrapper.className = 'view view-week';

  // ---- Sélecteur de semaine --------------------------------------------
  const nav = document.createElement('div');
  nav.className = 'date-nav';

  const prevBtn = document.createElement('button');
  prevBtn.className = 'icon-btn';
  prevBtn.textContent = '←';
  prevBtn.addEventListener('click', () => {
    selectedWeekStart = addDaysISO(selectedWeekStart, -7);
    rerender();
  });

  const weekEnd = addDaysISO(selectedWeekStart, 6);
  const label = document.createElement('button');
  label.className = 'date-label';
  label.textContent = `${formatDateFR(selectedWeekStart)} – ${formatDateFR(weekEnd)}`;
  label.title = 'Revenir à cette semaine';
  label.addEventListener('click', () => {
    selectedWeekStart = mondayOf(todayISO(new Date()));
    rerender();
  });

  const nextBtn = document.createElement('button');
  nextBtn.className = 'icon-btn';
  nextBtn.textContent = '→';
  nextBtn.addEventListener('click', () => {
    selectedWeekStart = addDaysISO(selectedWeekStart, 7);
    rerender();
  });

  nav.append(prevBtn, label, nextBtn);
  wrapper.appendChild(nav);

  function rerender() {
    container.innerHTML = '';
    renderWeekView(container);
  }

  // ---- Grille -------------------------------------------------------------
  const dayStartMin = timeToMinutes(state.settings.dayStartTime);
  const dayEndMin = timeToMinutes(state.settings.dayEndCutoff);
  const totalHeight = (dayEndMin - dayStartMin) * PX_PER_MINUTE;
  const hourPx = 60 * PX_PER_MINUTE;

  const scrollWrap = document.createElement('div');
  scrollWrap.className = 'week-grid-scroll';

  const inner = document.createElement('div');
  inner.className = 'week-grid-inner';

  const dayDates = Array.from({ length: 7 }, (_, i) => addDaysISO(selectedWeekStart, i));
  const todayIso = todayISO(new Date());

  // Ligne d'en-tête (jours), défile horizontalement avec la grille, reste
  // fixée en haut pendant le défilement vertical.
  const headerRow = document.createElement('div');
  headerRow.className = 'week-row week-header-row';
  const headerSpacer = document.createElement('div');
  headerSpacer.className = 'week-hours-col';
  headerRow.appendChild(headerSpacer);
  for (const d of dayDates) {
    const h = document.createElement('div');
    h.className = 'week-day-header' + (d === todayIso ? ' is-today' : '');
    h.textContent = formatDateFR(d);
    headerRow.appendChild(h);
  }
  inner.appendChild(headerRow);

  // Corps : colonne d'heures (fixée à gauche) + une colonne par jour.
  const bodyRow = document.createElement('div');
  bodyRow.className = 'week-row week-body-row';

  const hoursCol = document.createElement('div');
  hoursCol.className = 'week-hours-col';
  hoursCol.style.height = totalHeight + 'px';
  for (let m = dayStartMin; m <= dayEndMin; m += 60) {
    const lbl = document.createElement('div');
    lbl.className = 'week-hour-label';
    lbl.style.top = (m - dayStartMin) * PX_PER_MINUTE + 'px';
    lbl.textContent = minutesToTime(m);
    hoursCol.appendChild(lbl);
  }
  bodyRow.appendChild(hoursCol);

  let blockStagger = 0;
  for (const dateISO of dayDates) {
    const col = document.createElement('div');
    col.className = 'week-day-col';
    col.style.height = totalHeight + 'px';
    col.style.backgroundImage = `repeating-linear-gradient(to bottom, var(--border) 0, var(--border) 1px, transparent 1px, transparent ${hourPx}px)`;

    for (const item of collectDayItems(dateISO, state)) {
      const startMin = timeToMinutes(item.start);
      const endMin = timeToMinutes(item.end);
      const block = document.createElement('div');
      block.className = 'week-block' + (item.kind !== 'session' ? ' week-block-fixed' : '');
      block.style.top = (startMin - dayStartMin) * PX_PER_MINUTE + 'px';
      block.style.height = Math.max(16, (endMin - startMin) * PX_PER_MINUTE) + 'px';
      block.style.background = item.color;
      block.style.setProperty('--stagger', blockStagger++);
      block.textContent = item.label;
      block.addEventListener('click', () => openDetailCard(item, state));
      col.appendChild(block);
    }

    bodyRow.appendChild(col);
  }

  inner.appendChild(bodyRow);
  scrollWrap.appendChild(inner);
  wrapper.appendChild(scrollWrap);

  container.appendChild(wrapper);
}

// ---------------------------------------------------------------------------
// Fiche de détail (Modifier / Supprimer), pas de glisser-déposer.
// ---------------------------------------------------------------------------

function openDetailCard(item, state) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  let subjectLine = '';
  if (item.kind === 'session' && item.task) {
    const subj = subjectMeta(item.task.subject, state.settings);
    subjectLine = `<p class="meta">${escapeHtml(subj.label)}</p>`;
  }

  overlay.innerHTML = `
    <div class="modal-card">
      <p><strong>${escapeHtml(item.label)}</strong></p>
      <p class="meta">${item.start}–${item.end}</p>
      ${subjectLine}
      <div class="modal-actions">
        <button type="button" class="btn-secondary" data-action="close">Fermer</button>
        <button type="button" class="btn-secondary" data-action="edit">Modifier</button>
        ${item.kind === 'travel' ? '' : '<button type="button" class="btn-primary btn-danger" data-action="delete">Supprimer</button>'}
      </div>
    </div>
  `;

  overlay.addEventListener('click', (e) => {
    const action = e.target.dataset && e.target.dataset.action;
    if (!action) return;

    if (action === 'edit') {
      if (item.kind === 'session' && item.task) {
        location.hash = '#/ajouter?edit=' + item.task.id;
      } else {
        location.hash = '#/reglages';
      }
      overlay.remove();
      return;
    }

    if (action === 'delete') {
      if (item.kind === 'session' && item.task) {
        if (confirm(`Supprimer « ${item.task.title} » et toutes ses sessions planifiées ?`)) deleteTask(item.task.id);
      } else if (item.kind === 'constraint') {
        if (confirm(`Supprimer le créneau « ${item.ref.label} » ?`)) deleteWeeklyConstraint(item.ref.id);
      } else if (item.kind === 'event') {
        if (confirm(`Supprimer « ${item.ref.label} » ?`)) deleteOneOffEvent(item.ref.id);
      }
      overlay.remove();
      return;
    }

    overlay.remove(); // 'close'
  });

  document.body.appendChild(overlay);
}
