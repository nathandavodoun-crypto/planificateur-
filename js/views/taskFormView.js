// Saisie rapide : devoir (< 15s), colle, ou chapitre — un sélecteur en haut
// bascule entre les trois petits formulaires, sans changer d'onglet.

import { getState, addTask, addTasksBulk, updateTask, addOneOffEvent, addRecurringColleTemplate, addChapter, addChaptersBulk, setColleChapters } from '../store.js';
import { DEFAULT_DURATION_MINUTES_BY_TYPE, TASK_TYPE_LABELS } from '../models.js';
import { todayISO, addDaysISO } from '../utils/date.js';
import { fetchDeckNames, deckNameToChapter } from '../ankiConnect.js';

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
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const editId = params.get('edit');
  const editingTask = editId ? state.tasks.find((t) => t.id === editId) : null;
  if (editingTask) activeTab = 'devoir';

  const wrapper = document.createElement('div');
  wrapper.className = 'view view-task-form';

  const tabs = document.createElement('div');
  tabs.className = 'form-tabs';
  for (const [key, label] of [
    ['devoir', 'Devoir'],
    ['revision', 'Révision'],
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

  if (activeTab === 'revision') {
    renderRevisionForm(wrapper, state);
  } else if (activeTab === 'colle') {
    renderColleForm(wrapper, state);
  } else if (activeTab === 'chapitre') {
    renderChapitreForm(wrapper, state);
  } else {
    renderDevoirForm(wrapper, state, editingTask);
  }

  container.appendChild(wrapper);
}

// ---------------------------------------------------------------------------
// Devoir
// ---------------------------------------------------------------------------

function renderDevoirForm(wrapper, state, editingTask) {
  const title = document.createElement('h2');
  title.textContent = editingTask ? 'Modifier le devoir' : 'Ajouter un devoir';
  wrapper.appendChild(title);

  const t = editingTask;
  const form = document.createElement('form');
  form.className = 'task-form';
  form.innerHTML = `
    <label>Matière
      <select name="subject">
        ${state.settings.subjects.map((s) => `<option value="${escapeHtml(s.id)}" ${t?.subject === s.id ? 'selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}
      </select>
    </label>

    <label>Type
      <select name="type">
        ${Object.entries(TASK_TYPE_LABELS)
          .filter(([id]) => id !== 'revision_espacee') // généré automatiquement, pas saisi à la main
          .map(([id, label]) => `<option value="${id}" ${t?.type === id ? 'selected' : ''}>${escapeHtml(label)}</option>`)
          .join('')}
      </select>
    </label>

    <label>Titre (facultatif)
      <input type="text" name="title" placeholder="ex. DM d'intégrales n°4" value="${escapeHtml(t?.title || '')}" />
    </label>

    <label>Date limite
      <input type="date" name="deadlineDate" required min="${todayISO(new Date())}" value="${t?.deadlineDate || ''}" />
    </label>

    <label>Heure limite (facultatif)
      <input type="time" name="deadlineTime" value="${t?.deadlineTime || ''}" />
    </label>

    <label>Durée estimée (en minutes)
      <input type="number" name="estimatedDurationMinutes" min="10" step="5" required value="${t?.estimatedDurationMinutes ?? ''}" />
    </label>

    <label>Priorité
      <select name="priority">
        <option value="1" ${t?.priority === 1 ? 'selected' : ''}>Basse</option>
        <option value="2" ${!t || t.priority === 2 ? 'selected' : ''}>Normale</option>
        <option value="3" ${t?.priority === 3 ? 'selected' : ''}>Haute</option>
      </select>
    </label>

    <button type="submit" class="btn-primary">${editingTask ? 'Enregistrer les modifications' : 'Ajouter au planning'}</button>
  `;

  const typeSelect = form.elements.type;
  const durationInput = form.elements.estimatedDurationMinutes;

  function applyDefaultDuration() {
    durationInput.value = DEFAULT_DURATION_MINUTES_BY_TYPE[typeSelect.value] ?? 60;
  }
  typeSelect.addEventListener('change', applyDefaultDuration);
  if (!editingTask) applyDefaultDuration(); // ne pas écraser une durée déjà saisie en édition

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const subject = data.get('subject');
    const type = data.get('type');
    const subjectLabel = state.settings.subjects.find((s) => s.id === subject)?.label || subject;
    const typeLabel = TASK_TYPE_LABELS[type];
    const rawTitle = data.get('title')?.trim();

    const payload = {
      subject,
      type,
      title: rawTitle || `${typeLabel} — ${subjectLabel}`,
      deadlineDate: data.get('deadlineDate'),
      deadlineTime: data.get('deadlineTime') || null,
      estimatedDurationMinutes: Number(data.get('estimatedDurationMinutes')),
      priority: Number(data.get('priority')),
    };

    if (editingTask) {
      updateTask(editingTask.id, payload);
      location.hash = '#/devoirs';
    } else {
      addTask(payload);
      // Retour direct sur la vue Jour : la meilleure confirmation, c'est de
      // voir tout de suite où le devoir a été casé.
      location.hash = '#/jour';
    }
  });

  wrapper.appendChild(form);
}

// Ma liste de chapitres à réviser pendant les vacances (ajout en un clic).
const VACATION_CHAPTERS = [
  { subject: 'maths', chapters: [1, 2, 3, 4, 5, 6, 7] },
  { subject: 'info', chapters: [1, 2] },
  { subject: 'physique', chapters: [0, 1, 2, 3, 4, 5] },
  { subject: 'si', chapters: [1, 2] },
  { subject: 'chimie', chapters: [1, 2, 3] },
];

/** Les chapitres en alternant les matières (un tour de chaque matière à la fois), pour varier d'un jour à l'autre. */
function vacationChapterRows() {
  const rows = [];
  const longest = Math.max(...VACATION_CHAPTERS.map((g) => g.chapters.length));
  for (let i = 0; i < longest; i++) {
    for (const group of VACATION_CHAPTERS) {
      if (i < group.chapters.length) rows.push({ subject: group.subject, title: `Révision — Chapitre ${group.chapters[i]}` });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Révision de chapitre : un chapitre = UN bloc d'affilée (3 h par défaut)
// ---------------------------------------------------------------------------

function renderRevisionForm(wrapper, state) {
  const title = document.createElement('h2');
  title.textContent = 'Réviser un chapitre';
  wrapper.appendChild(title);

  const note = document.createElement('p');
  note.className = 'notice';
  note.textContent =
    "Tu donnes juste le(s) chapitre(s) : chacun devient UN bloc de révision d'affilée (3 h par défaut), jamais découpé en petits morceaux ni espacé. Plusieurs chapitres = un par jour, tant que la journée ne peut pas en contenir deux.";
  wrapper.appendChild(note);

  const today = todayISO(new Date());
  // Date par défaut : la fin des vacances en cours ou à venir, sinon dans une semaine.
  const vac = (state.vacations || []).filter((v) => v.endDate >= today).sort((a, b) => (a.endDate < b.endDate ? -1 : 1))[0];
  const defaultDeadline = vac ? vac.endDate : addDaysISO(today, 7);

  const form = document.createElement('form');
  form.className = 'task-form';
  form.innerHTML = `
    <label>Matière
      <select name="subject">
        ${state.settings.subjects.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.label)}</option>`).join('')}
      </select>
    </label>
    <label>Chapitre(s) — un par ligne
      <textarea name="chapters" rows="4" required placeholder="ex. Suites numériques&#10;Intégrales"></textarea>
    </label>
    <label>Durée du bloc (en minutes)
      <input type="number" name="minutes" min="30" step="15" required value="180" />
    </label>
    <label>À faire avant le
      <input type="date" name="deadlineDate" required min="${today}" value="${defaultDeadline}" />
    </label>
    <button type="submit" class="btn-primary">Ajouter au planning</button>
  `;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const subject = data.get('subject');
    const lines = String(data.get('chapters'))
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return;
    for (const chapter of lines) {
      addTask({
        subject,
        type: 'revision_chapitre',
        title: `Révision — ${chapter}`,
        deadlineDate: data.get('deadlineDate'),
        estimatedDurationMinutes: Number(data.get('minutes')),
        priority: 2,
      });
    }
    location.hash = '#/jour';
  });
  wrapper.appendChild(form);

  // ---- Ma liste de vacances en un clic ------------------------------------------------
  const quick = document.createElement('div');
  quick.className = 'section';
  const rows = vacationChapterRows();
  const quickBtn = document.createElement('button');
  quickBtn.type = 'button';
  quickBtn.className = 'btn-secondary';
  quickBtn.textContent = `📚 Ajouter ma liste de vacances (${rows.length} chapitres)`;
  const quickNote = document.createElement('p');
  quickNote.className = 'meta';
  quickNote.textContent =
    'Maths 1 à 7 · Info 1 à 2 · Physique 0 à 5 · SI 1 à 2 · Chimie 1 à 3. Un bloc par chapitre, avec la durée et la date « à faire avant le » ci-dessus (les matières sont alternées d\'un jour à l\'autre).';
  quickBtn.addEventListener('click', () => {
    const data = new FormData(form);
    const deadlineDate = data.get('deadlineDate');
    const minutes = Number(data.get('minutes')) || 180;
    if (!deadlineDate) {
      alert('Choisis d\'abord la date « à faire avant le ».');
      return;
    }
    const existing = new Set(getState().tasks.filter((t) => t.type === 'revision_chapitre').map((t) => `${t.subject}|${t.title}`));
    const toAdd = rows.filter((r) => !existing.has(`${r.subject}|${r.title}`));
    if (toAdd.length === 0) {
      alert('Ces chapitres sont déjà tous dans ton planning.');
      return;
    }
    const days = Math.round((new Date(deadlineDate + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000) + 1;
    const hours = Math.round(((toAdd.length * minutes) / 60) * 10) / 10;
    const warn =
      days < toAdd.length
        ? `\n\nAttention : il n'y a que ${days} jour(s) d'ici là, pour ${toAdd.length} blocs (un seul bloc par jour). Les blocs qui ne tiennent pas seront signalés comme impossibles : choisis une date plus lointaine.`
        : '';
    if (!confirm(`Ajouter ${toAdd.length} blocs de ${minutes / 60} h (${hours} h au total) à faire avant le ${deadlineDate} ?${warn}`)) return;
    addTasksBulk(
      toAdd.map((r) => ({ subject: r.subject, type: 'revision_chapitre', title: r.title, deadlineDate, estimatedDurationMinutes: minutes, priority: 2 }))
    );
    location.hash = '#/jour';
  });
  quick.append(quickBtn, quickNote);
  wrapper.appendChild(quick);
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
    if (endTime <= startTime) {
      alert("L'heure de fin doit être après l'heure de début.");
      return;
    }
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

  const ankiNotice = document.createElement('p');
  ankiNotice.className = 'notice';
  ankiNotice.textContent =
    "Marche uniquement depuis cet ordinateur, avec Anki Desktop ouvert et l'extension AnkiConnect installée (voir Réglages pour la configurer une fois).";

  const ankiBtn = document.createElement('button');
  ankiBtn.type = 'button';
  ankiBtn.className = 'btn-secondary';
  ankiBtn.textContent = '📥 Importer depuis Anki';

  const ankiStatus = document.createElement('div');

  ankiBtn.addEventListener('click', async () => {
    ankiBtn.disabled = true;
    ankiStatus.innerHTML = '<p class="notice">Connexion à Anki…</p>';
    try {
      const deckNames = await fetchDeckNames();
      if (deckNames.length === 0) {
        ankiStatus.innerHTML = '<p class="notice">Aucun paquet trouvé dans Anki (à part "Default").</p>';
        return;
      }
      renderDeckPicker(deckNames);
    } catch (e) {
      ankiStatus.innerHTML = `<p class="notice">${escapeHtml(e.message)}</p>`;
    } finally {
      ankiBtn.disabled = false;
    }
  });

  function renderDeckPicker(deckNames) {
    ankiStatus.innerHTML =
      '<p class="notice">Paquets trouvés — coche ceux à suivre ici (tu pourras ajuster matière/date avant d\'importer) :</p><div class="days-picker" data-anki-decks></div>';
    const picker = ankiStatus.querySelector('[data-anki-decks]');
    for (const name of deckNames) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = name;
      label.append(checkbox, document.createTextNode(name));
      picker.appendChild(label);
    }

    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'btn-secondary';
    importBtn.textContent = 'Ajouter les paquets cochés';
    importBtn.addEventListener('click', () => {
      const checked = [...picker.querySelectorAll('input:checked')].map((el) => el.value);
      for (const deckName of checked) {
        const { subject, title } = deckNameToChapter(deckName, state.settings.subjects);
        addRow({ subject, title, dateSeen: today });
      }
      ankiStatus.innerHTML = '';
    });
    ankiStatus.appendChild(importBtn);
  }

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn-primary';
  submitBtn.textContent = 'Importer tous les chapitres';

  form.append(rowsContainer, addRowBtn, ankiNotice, ankiBtn, ankiStatus, submitBtn);

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
