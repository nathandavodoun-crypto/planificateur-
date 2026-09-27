// Saisie rapide d'un devoir (objectif : moins de 15 secondes).

import { getState, addTask } from '../store.js';
import { DEFAULT_DURATION_MINUTES_BY_TYPE, TASK_TYPE_LABELS } from '../models.js';
import { todayISO } from '../utils/date.js';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

export function renderTaskFormView(container) {
  const state = getState();

  const wrapper = document.createElement('div');
  wrapper.className = 'view view-task-form';

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
        ${Object.entries(TASK_TYPE_LABELS).map(([id, label]) => `<option value="${id}">${escapeHtml(label)}</option>`).join('')}
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
  container.appendChild(wrapper);
}
