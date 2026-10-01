// Saisie rapide : devoir (< 15s), colle, ou chapitre — un sélecteur en haut
// bascule entre les trois petits formulaires, sans changer d'onglet.

import { getState, addTask, addOneOffEvent, addRecurringColleTemplate, addChapter, addChaptersBulk, setColleChapters } from '../store.js';
import { DEFAULT_DURATION_MINUTES_BY_TYPE, TASK_TYPE_LABELS } from '../models.js';
import { todayISO } from '../utils/date.js';

const DAYS_OPTIONS = [
  { index: 1, label: 'Lundi' },
  { index: 2, label: 'Mardi' },
  { index: 3, label: 'Mercredi' },
  { index: 4, label: 'Jeudi' },
  { index: 5, label: 'Vendredi' },
  { index: 6, label: 'Samedi' },
  { index: 0, label: 'Dimanche' },
];

// Onglet actif du sélecteur — conservé au niveau du module, comme selectedDate
// dans dayView, pour survivre aux re-rendus déclenchés par le store.
let activeTab = 'devoir';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

export function renderTaskFormView(container) {
  const state = getState();

  const wrapper = document.createElement('div');
  wrapper.className = 'view view-task-form';

  const tabs = document.createElement('div');
  tabs.className = 'form-tabs';
  for (const [key, label] of [
    ['devoir', 'Devoir'],
    ['colle', 'Colle'],
    ['chapitre', 'Chapitre'],
  ]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'form-tab' + (activeTab === key ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      activeTab = key;
      container.innerHTML = '';
      renderTaskFormView(container);
    });
    tabs.appendChild(btn);
  }
  wrapper.appendChild(tabs);

  if (activeTab === 'colle') {
    renderColleForm(wrapper, state);
  } else if (activeTab === 'chapitre') {
    renderChapitreForm(wrapper, state);
  } else {
    renderDevoirForm(wrapper, state);
  }

  container.appendChild(wrapper);
}

// ---------------------------------------------------------------------------
// Devoir
// ---------------------------------------------------------------------------

function renderDevoirForm(wrapper, state) {
  const title = document.createElement('h2');
  title.textContent = 'Ajouter un devoir';
  wrapper.appendChild(title);

  const form = document.createElement('form');
  form.className = 'task-form';
  form.innerHTML = `
    <label>Matière
      <select name="subject">
        ${state.settings.subjects.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.label)}</option>`).join('')}
      </select>
    </label>

    <label>Type
      <select name="type">
        ${Object.entries(TASK_TYPE_LABELS)
          .filter(([id]) => id !== 'revision_espacee') // généré automatiquement, pas saisi à la main
          .map(([id, label]) => `<option value="${id}">${escapeHtml(label)}</option>`)
          .join('')}
      </select>
    </label>

    <label>Titre (facultatif)
      <input type="text" name="title" placeholder="ex. DM d'intégrales n°4" />
    </label>

    <label>Date limite
      <input type="date" name="deadlineDate" required min="${todayISO(new Date())}" />
    </label>

    <label>Heure limite (facultatif)
      <input type="time" name="deadlineTime" />
    </label>

    <label>Durée estimée (en minutes)
      <input type="number" name="estimatedDurationMinutes" min="10" step="5" required />
    </label>

    <label>Priorité
      <select name="priority">
        <option value="1">Basse</option>
        <option value="2" selected>Normale</option>
        <option value="3">Haute</option>
      </select>
    </label>

    <button type="submit" class="btn-primary">Ajouter au planning</button>
  `;

  const typeSelect = form.elements.type;
  const durationInput = form.elements.estimatedDurationMinutes;

  function applyDefaultDuration() {
    durationInput.value = DEFAULT_DURATION_MINUTES_BY_TYPE[typeSelect.value] ?? 60;
  }
  typeSelect.addEventListener('change', applyDefaultDuration);
  applyDefaultDuration();

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const subject = data.get('subject');
    const type = data.get('type');
    const subjectLabel = state.settings.subjects.find((s) => s.id === subject)?.label || subject;
    const typeLabel = TASK_TYPE_LABELS[type];
    const rawTitle = data.get('title')?.trim();

    addTask({
      subject,
      type,
      title: rawTitle || `${typeLabel} — ${subjectLabel}`,
      deadlineDate: data.get('deadlineDate'),
      deadlineTime: data.get('deadlineTime') || null,
      estimatedDurationMinutes: Number(data.get('estimatedDurationMinutes')),
      priority: Number(data.get('priority')),
    });

    // Retour direct sur la vue Jour : la meilleure confirmation, c'est de
    // voir tout de suite où le devoir a été casé.
    location.hash = '#/jour';
  });

  wrapper.appendChild(form);
}

// ---------------------------------------------------------------------------
// Colle
// ---------------------------------------------------------------------------

function renderColleForm(wrapper, state) {
  const title = document.createElement('h2');
  title.textContent = 'Ajouter une colle';
  wrapper.appendChild(title);

  const form = document.createElement('form');
  form.className = 'task-form';
  form.innerHTML = `
    <label>Matière
      <select name="subject">
        ${state.settings.subjects.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.label)}</option>`).join('')}
      </select>
    </label>

    <label class="checkbox-row">
      <input type="checkbox" name="recurring" />
      Colle récurrente (même créneau chaque semaine)
    </label>

    <div data-field="date-field">
      <label>Date
        <input type="date" name="date" required min="${todayISO(new Date())}" />
      </label>
    </div>
    <div data-field="day-field" style="display:none">
      <label>Jour de la semaine
        <select name="dayOfWeek">
          ${DAYS_OPTIONS.map((d) => `<option value="${d.index}">${d.label}</option>`).join('')}
        </select>
      </label>
    </div>

    <div class="settings-grid">
      <label>Début
        <input type="time" name="startTime" value="14:00" required />
      </label>
      <label>Fin
        <input type="time" name="endTime" value="14:20" required />
      </label>
    </div>

    <div data-field="chapters-field"></div>

    <label>+ Nouveau chapitre pour cette colle (facultatif)
      <input type="text" name="newChapterTitle" placeholder="ex. Suites numériques" />
    </label>

    <button type="submit" class="btn-primary">Ajouter la colle</button>
  `;

  const subjectSelect = form.elements.subject;
  const recurringCheckbox = form.elements.recurring;
  const dateField = form.querySelector('[data-field="date-field"]');
  const dayField = form.querySelector('[data-field="day-field"]');
  const chaptersField = form.querySelector('[data-field="chapters-field"]');

  function renderChapterPicker() {
    const subject = subjectSelect.value;
    const chapters = state.chapters.filter((c) => c.subject === subject && c.status !== 'archive');
    if (chapters.length === 0) {
      chaptersField.innerHTML = '<p class="notice">Aucun chapitre existant pour cette matière — tu peux en créer un juste en dessous.</p>';
      return;
    }
    chaptersField.innerHTML =
      '<p class="notice">Chapitre(s) concerné(s) :</p><div class="days-picker">' +
      chapters
        .map(
          (c) =>
            `<label><input type="checkbox" name="chapterId" value="${c.id}" />${escapeHtml(c.title)}</label>`
        )
        .join('') +
      '</div>';
  }
  subjectSelect.addEventListener('change', renderChapterPicker);
  renderChapterPicker();

  recurringCheckbox.addEventListener('change', () => {
    const recurring = recurringCheckbox.checked;
    dateField.style.display = recurring ? 'none' : '';
    dayField.style.display = recurring ? '' : 'none';
    form.elements.date.required = !recurring;
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const subject = data.get('subject');
    const subjectLabel = state.settings.subjects.find((s) => s.id === subject)?.label || subject;
    const startTime = data.get('startTime');
    const endTime = data.get('endTime');
    const recurring = data.get('recurring') === 'on';

    const chapterIds = [...form.querySelectorAll('input[name="chapterId"]:checked')].map((el) => el.value);
    const newChapterTitle = data.get('newChapterTitle')?.trim();
    if (newChapterTitle) {
      const chapter = addChapter({ subject, title: newChapterTitle, dateSeen: todayISO(new Date()) });
      chapterIds.push(chapter.id);
    }

    let eventId;
    if (recurring) {
      const template = addRecurringColleTemplate({
        subject,
        label: `Colle ${subjectLabel}`,
        dayOfWeek: Number(data.get('dayOfWeek')),
        startTime,
        endTime,
      });
      // La première occurrence vient d'être générée par ensureRecurringColleInstances (via commit()).
      const instance = getState().oneOffEvents.find((e) => e.templateId === template.id);
      eventId = instance?.id;
    } else {
      const eventObj = addOneOffEvent({
        category: 'colle',
        label: `Colle ${subjectLabel}`,
        subject,
        date: data.get('date'),
        startTime,
        endTime,
      });
      eventId = eventObj.id;
    }

    if (eventId && chapterIds.length > 0) {
      setColleChapters(eventId, chapterIds);
    }

    location.hash = '#/jour';
  });

  wrapper.appendChild(form);
}

// ---------------------------------------------------------------------------
// Chapitre
// ---------------------------------------------------------------------------

// Mode du formulaire Chapitre (un seul, ou import groupé) — conservé au
// niveau du module pour survivre aux re-rendus, comme activeTab.
let chapitreBulkMode = false;

function renderChapitreForm(wrapper, state) {
  const title = document.createElement('h2');
  title.textContent = 'Ajouter un chapitre';
  wrapper.appendChild(title);

  const intro = document.createElement('p');
  intro.className = 'notice';
  intro.textContent =
    'Un chapitre vu en cours est automatiquement suivi en répétition espacée (J+1, J+7, J+30 par défaut, réglable dans Réglages). Si des révisions sont déjà dépassées (chapitre ancien), une seule révision de rattrapage est programmée dans les prochains jours, puis le cycle normal reprend.';
  wrapper.appendChild(intro);

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'btn-secondary';
  toggleBtn.textContent = chapitreBulkMode ? 'Revenir à l\'ajout simple' : 'Importer plusieurs chapitres d\'un coup';
  toggleBtn.addEventListener('click', () => {
    const container = wrapper.parentElement; // capturé AVANT de vider : wrapper est détaché par innerHTML=''
    chapitreBulkMode = !chapitreBulkMode;
    container.innerHTML = '';
    renderTaskFormView(container);
  });
  wrapper.appendChild(toggleBtn);

  if (chapitreBulkMode) {
    renderChapitreBulkForm(wrapper, state);
  } else {
    renderChapitreSingleForm(wrapper, state);
  }
}

function renderChapitreSingleForm(wrapper, state) {
  const today = todayISO(new Date());
  const form = document.createElement('form');
  form.className = 'task-form';
  form.innerHTML = `
    <label>Matière
      <select name="subject">
        ${state.settings.subjects.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.label)}</option>`).join('')}
      </select>
    </label>

    <label>Titre du chapitre
      <input type="text" name="title" placeholder="ex. Intégrales" required />
    </label>

    <label>Date vue en cours
      <input type="date" name="dateSeen" required value="${today}" max="${today}" />
    </label>

    <label>Dernière révision faite (facultatif, si tu l'as déjà revu toi-même)
      <input type="date" name="lastReviewDate" max="${today}" />
    </label>

    <button type="submit" class="btn-primary">Ajouter et planifier les révisions</button>
  `;

  // La dernière révision ne peut pas précéder la date du cours.
  const dateSeenInput = form.elements.dateSeen;
  const lastReviewInput = form.elements.lastReviewDate;
  dateSeenInput.addEventListener('change', () => {
    lastReviewInput.min = dateSeenInput.value;
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    addChapter({
      subject: data.get('subject'),
      title: data.get('title').trim(),
      dateSeen: data.get('dateSeen'),
      lastReviewDate: data.get('lastReviewDate') || null,
    });
    location.hash = '#/devoirs';
  });

  wrapper.appendChild(form);
}

function renderChapitreBulkForm(wrapper, state) {
  const today = todayISO(new Date());

  const form = document.createElement('form');
  form.className = 'task-form';

  const rowsContainer = document.createElement('div');
  rowsContainer.className = 'bulk-rows';

  function addRow(values = {}) {
    const row = document.createElement('div');
    row.className = 'bulk-row';
    row.innerHTML = `
      <select name="bulkSubject">
        ${state.settings.subjects.map((s) => `<option value="${escapeHtml(s.id)}" ${values.subject === s.id ? 'selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}
      </select>
      <input type="text" name="bulkTitle" placeholder="Titre du chapitre" value="${escapeHtml(values.title || '')}" />
      <input type="date" name="bulkDateSeen" max="${today}" value="${values.dateSeen || ''}" />
      <button type="button" class="bulk-row-remove">✕</button>
    `;
    row.querySelector('.bulk-row-remove').addEventListener('click', () => {
      row.remove();
    });
    rowsContainer.appendChild(row);
  }

  // Trois lignes vides au départ : assez pour "plusieurs" sans surcharger l'écran.
  addRow();
  addRow();
  addRow();

  const addRowBtn = document.createElement('button');
  addRowBtn.type = 'button';
  addRowBtn.className = 'btn-secondary';
  addRowBtn.textContent = '+ Ajouter une ligne';
  addRowBtn.addEventListener('click', () => addRow());

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn-primary';
  submitBtn.textContent = 'Importer tous les chapitres';

  form.append(rowsContainer, addRowBtn, submitBtn);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const rows = [...rowsContainer.querySelectorAll('.bulk-row')]
      .map((row) => ({
        subject: row.querySelector('[name="bulkSubject"]').value,
        title: row.querySelector('[name="bulkTitle"]').value.trim(),
        dateSeen: row.querySelector('[name="bulkDateSeen"]').value,
      }))
      .filter((r) => r.title && r.dateSeen);

    if (rows.length === 0) {
      alert('Remplis au moins une ligne (titre + date) avant d\'importer.');
      return;
    }

    addChaptersBulk(rows);
    location.hash = '#/devoirs';
  });

  wrapper.appendChild(form);
}
