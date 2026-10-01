// Vue Jour — l'écran principal sur téléphone : ce qui est prévu aujourd'hui
// (cours, sport, sessions de travail), avec un geste pour marquer une session
// faite / non faite.

import { getState, getWarnings, setSessionStatus } from '../store.js';
import { todayISO, addDaysISO, formatDateFR, combineDateTime } from '../utils/date.js';
import { computeStreak } from '../stats.js';

const TYPE_BADGES = {
  preparation_colle: '🎤',
  revision_espacee: '🔁',
  revision_ds: '📘',
};
const TYPE_TITLES = {
  preparation_colle: 'Préparation de colle',
  revision_espacee: 'Révision espacée',
  revision_ds: 'Révision de DS',
};

// Jour actuellement affiché — conservé au niveau du module (pas du rendu) pour
// survivre aux re-rendus déclenchés par le store sans revenir à "aujourd'hui"
// à chaque changement.
let selectedDate = todayISO(new Date());

const CATEGORY_LABELS = {
  cours: 'Cours',
  sport: 'Sport',
  repas: 'Repas',
  trajet: 'Trajet',
  autre: 'Autre',
  ds: 'DS',
  colle: 'Colle',
  adhoc: 'Imprévu',
};

function subjectMeta(subjectId, settings) {
  return (settings.subjects || []).find((s) => s.id === subjectId) || { label: subjectId, color: '#6B7280' };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function dayBlocks(dateISO, state) {
  const weekday = new Date(dateISO + 'T00:00:00').getDay();
  const blocks = [];
  for (const c of state.weeklyConstraints) {
    if (c.active && c.daysOfWeek.includes(weekday)) {
      if (c.effectiveFrom && dateISO < c.effectiveFrom) continue;
      if (c.effectiveUntil && dateISO > c.effectiveUntil) continue;
      blocks.push({ start: c.startTime, end: c.endTime, label: `${CATEGORY_LABELS[c.category]} — ${c.label}` });
    }
  }
  for (const ev of state.oneOffEvents) {
    if (ev.date === dateISO) {
      let label = `${CATEGORY_LABELS[ev.category]} — ${ev.label}`;
      if (ev.category === 'colle' && ev.chapterIds?.length) {
        const titles = ev.chapterIds.map((id) => state.chapters.find((c) => c.id === id)?.title).filter(Boolean);
        if (titles.length) label += ` (${titles.join(', ')})`;
      }
      blocks.push({ start: ev.startTime, end: ev.endTime, label });
    }
  }
  return blocks;
}

export function renderDayView(container) {
  const state = getState();
  const warnings = getWarnings();
  const now = new Date();

  const wrapper = document.createElement('div');
  wrapper.className = 'view view-day';

  // ---- Sélecteur de jour --------------------------------------------------
  const dateNav = document.createElement('div');
  dateNav.className = 'date-nav';

  const prevBtn = document.createElement('button');
  prevBtn.className = 'icon-btn';
  prevBtn.textContent = '←';
  prevBtn.addEventListener('click', () => {
    selectedDate = addDaysISO(selectedDate, -1);
    rerender();
  });

  const dateLabel = document.createElement('button');
  dateLabel.className = 'date-label';
  dateLabel.textContent = formatDateFR(selectedDate);
  dateLabel.title = "Revenir à aujourd'hui";
  dateLabel.addEventListener('click', () => {
    selectedDate = todayISO(new Date());
    rerender();
  });

  const nextBtn = document.createElement('button');
  nextBtn.className = 'icon-btn';
  nextBtn.textContent = '→';
  nextBtn.addEventListener('click', () => {
    selectedDate = addDaysISO(selectedDate, 1);
    rerender();
  });

  dateNav.append(prevBtn, dateLabel, nextBtn);
  wrapper.appendChild(dateNav);

  const streak = computeStreak(state, now);
  if (streak > 0) {
    const streakBadge = document.createElement('div');
    streakBadge.className = 'streak-badge';
    streakBadge.textContent = `🔥 ${streak} jour${streak > 1 ? 's' : ''} de suite`;
    wrapper.appendChild(streakBadge);
  }

  function rerender() {
    container.innerHTML = '';
    renderDayView(container);
  }

  // ---- Avertissements de surcharge -----------------------------------------
  if (warnings.length > 0) {
    const banner = document.createElement('div');
    banner.className = 'warning-banner';
    banner.innerHTML =
      '<strong>⚠ Planning surchargé</strong>' +
      warnings.map((w) => `<div>${escapeHtml(w.message)}</div>`).join('');
    wrapper.appendChild(banner);
  }

  // ---- Créneaux fixes + sessions de travail, triés par heure ---------------
  const blocks = dayBlocks(selectedDate, state);
  const sessionsToday = state.sessions
    .filter((s) => s.date === selectedDate)
    .map((session) => ({ session, task: state.tasks.find((t) => t.id === session.taskId) }));

  const items = [
    ...blocks.map((b) => ({ start: b.start, node: renderBlockItem(b) })),
    ...sessionsToday.map(({ session, task }) => ({ start: session.startTime, node: renderSessionItem(session, task, state.settings, now) })),
  ].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  const timeline = document.createElement('div');
  timeline.className = 'timeline';

  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'Rien de prévu ce jour-là.';
    timeline.appendChild(empty);
  } else {
    items.forEach((item, i) => {
      item.node.style.setProperty('--stagger', i);
      timeline.appendChild(item.node);
    });
  }
  wrapper.appendChild(timeline);

  container.appendChild(wrapper);
}

function renderBlockItem(b) {
  const el = document.createElement('div');
  el.className = 'timeline-item block';
  el.innerHTML = `<div class="time">${b.start}–${b.end}</div><div class="content">${escapeHtml(b.label)}</div>`;
  return el;
}

function renderSessionItem(session, task, settings, now) {
  const el = document.createElement('div');
  el.className = `timeline-item session status-${session.status}`;
  const subj = task ? subjectMeta(task.subject, settings) : { label: '?', color: '#6B7280' };
  el.style.setProperty('--subject-color', subj.color);

  const time = document.createElement('div');
  time.className = 'time';
  time.textContent = `${session.startTime}–${session.endTime}`;

  const badge = task ? TYPE_BADGES[task.type] : null;

  const content = document.createElement('div');
  content.className = 'content';
  content.innerHTML = `<span class="subject-pill" style="background:${subj.color}">${escapeHtml(subj.label)}</span>${
    badge ? `<span class="type-badge" title="${escapeHtml(TYPE_TITLES[task.type] || '')}">${badge}</span> ` : ''
  }${escapeHtml(task ? task.title : '')}`;

  const actions = document.createElement('div');
  actions.className = 'actions';

  const isPast = combineDateTime(session.date, session.endTime).getTime() <= now.getTime();

  if (session.status === 'planifiee') {
    const doneBtn = document.createElement('button');
    doneBtn.className = 'btn-done';
    doneBtn.textContent = '✓';
    doneBtn.title = 'Marquer comme fait';
    doneBtn.addEventListener('click', async () => {
      const chaptersToRate = chaptersNeedingRating(session, task, getState());
      if (chaptersToRate.length === 0) {
        setSessionStatus(session.id, 'terminee');
        return;
      }
      const difficultyByChapter = await askDifficulties(chaptersToRate);
      setSessionStatus(session.id, 'terminee', difficultyByChapter);
    });
    actions.appendChild(doneBtn);

    // "Non faite" n'a un sens réel que pour une session déjà passée : pour
    // une session future, la marquer non faite la ferait juste régénérer à
    // l'identique au recalcul suivant.
    if (isPast) {
      const missBtn = document.createElement('button');
      missBtn.className = 'btn-miss';
      missBtn.textContent = '✕';
      missBtn.title = 'Marquer comme non faite (sera replanifiée)';
      missBtn.addEventListener('click', () => setSessionStatus(session.id, 'non_faite'));
      actions.appendChild(missBtn);
    }
  } else {
    const undoBtn = document.createElement('button');
    undoBtn.className = 'btn-undo';
    undoBtn.textContent = '↺';
    undoBtn.title = 'Annuler ce statut';
    undoBtn.addEventListener('click', () => setSessionStatus(session.id, 'planifiee'));
    actions.appendChild(undoBtn);
  }

  el.append(time, content, actions);
  return el;
}

// ---------------------------------------------------------------------------
// Facile / difficile — demandé une fois par chapitre concerné, uniquement
// quand la session cochée termine entièrement la tâche (dernière session
// d'une révision espacée, ou d'une préparation de colle fusionnée).
// ---------------------------------------------------------------------------

function chaptersNeedingRating(session, task, state) {
  if (!task) return [];
  const doneMinutesAfter = state.sessions
    .filter((s) => s.taskId === task.id && (s.status === 'terminee' || s.id === session.id))
    .reduce((sum, s) => sum + s.durationMinutes, 0);
  if (doneMinutesAfter < task.estimatedDurationMinutes) return []; // pas encore la dernière session

  if (task.type === 'revision_espacee' && task.chapterId) {
    const ch = state.chapters.find((c) => c.id === task.chapterId);
    return ch && ch.status === 'active' ? [ch] : [];
  }
  if (task.type === 'preparation_colle' && task.linkedChapterIds?.length) {
    return task.linkedChapterIds
      .map((id) => state.chapters.find((c) => c.id === id))
      .filter((ch) => ch && ch.status === 'active' && ch.fusedIntoEventId === task.linkedEventId);
  }
  return [];
}

function askDifficulty(chapterTitle) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card">
        <p>« ${escapeHtml(chapterTitle)} » — comment ça s'est passé ?</p>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" data-choice="difficile">Difficile</button>
          <button type="button" class="btn-primary" data-choice="facile">Facile</button>
        </div>
      </div>
    `;
    overlay.addEventListener('click', (e) => {
      const choice = e.target.dataset && e.target.dataset.choice;
      if (choice) {
        overlay.remove();
        resolve(choice);
      }
    });
    document.body.appendChild(overlay);
  });
}

async function askDifficulties(chapters) {
  const result = {};
  for (const ch of chapters) {
    result[ch.id] = await askDifficulty(ch.title);
  }
  return result;
}
