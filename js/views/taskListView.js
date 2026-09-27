// Liste des devoirs : statut, temps restant, et suppression — la vue
// manquait pour pouvoir retirer un devoir ajouté par erreur ou plus utile.

import { getState, deleteTask } from '../store.js';
import { TASK_TYPE_LABELS } from '../models.js';
import { formatDateFR, formatDuration } from '../utils/date.js';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function subjectMeta(subjectId, settings) {
  return (settings.subjects || []).find((s) => s.id === subjectId) || { label: subjectId, color: '#6B7280' };
}

// Statut affiché, dérivé des sessions plutôt que du champ `task.status`
// (réservé à une fermeture manuelle) : à faire / en cours / terminé.
function computeStatus(task, sessions) {
  const taskSessions = sessions.filter((s) => s.taskId === task.id);
  const doneMinutes = taskSessions.filter((s) => s.status === 'terminee').reduce((sum, s) => sum + s.durationMinutes, 0);
  const remaining = Math.max(0, task.estimatedDurationMinutes - doneMinutes);
  if (task.status === 'termine' || remaining <= 0) return { label: 'Terminé', remaining: 0 };
  if (doneMinutes > 0) return { label: 'En cours', remaining };
  return { label: 'À faire', remaining };
}

export function renderTaskListView(container) {
  const state = getState();
  const wrapper = document.createElement('div');
  wrapper.className = 'view view-task-list';

  const title = document.createElement('h2');
  title.textContent = 'Mes devoirs';
  wrapper.appendChild(title);

  const tasks = [...state.tasks].sort((a, b) => {
    const da = a.deadlineDate || '9999-99-99';
    const db = b.deadlineDate || '9999-99-99';
    return da < db ? -1 : da > db ? 1 : 0;
  });

  if (tasks.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = "Aucun devoir pour l'instant.";
    wrapper.appendChild(empty);
  }

  for (const task of tasks) {
    const { label: statusLabel, remaining } = computeStatus(task, state.sessions);
    const subj = subjectMeta(task.subject, state.settings);

    const item = document.createElement('div');
    item.className = 'list-item task-item';
    if (statusLabel === 'Terminé') item.classList.add('is-done');

    const info = document.createElement('div');
    info.innerHTML = `
      <div>
        <span class="subject-pill" style="background:${subj.color}">${escapeHtml(subj.label)}</span>
        <strong>${escapeHtml(task.title)}</strong>
      </div>
      <div class="meta">
        ${escapeHtml(TASK_TYPE_LABELS[task.type] || task.type)} ·
        échéance ${task.deadlineDate ? formatDateFR(task.deadlineDate) : '—'}${task.deadlineTime ? ' ' + task.deadlineTime : ''} ·
        ${statusLabel}${remaining > 0 ? ` (reste ${formatDuration(remaining)})` : ''}
      </div>
    `;

    const delBtn = document.createElement('button');
    delBtn.textContent = '✕';
    delBtn.title = 'Supprimer ce devoir';
    delBtn.addEventListener('click', () => {
      if (confirm(`Supprimer « ${task.title} » et toutes ses sessions planifiées ?`)) {
        deleteTask(task.id);
      }
    });

    item.append(info, delBtn);
    wrapper.appendChild(item);
  }

  container.appendChild(wrapper);
}
